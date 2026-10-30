import { and, eq, sql } from "drizzle-orm";
import { accounts, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { parseCsv, parseNumberCell } from "../utils/csv.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { STORE_CREDIT_SUBTYPE } from "./account-scope.js";
import { OPENING_BALANCE_NAME, recomputeManualBalance } from "./manual-transaction.service.js";
import { applyRules } from "./rule.service.js";
import { detectInternalTransfers } from "./transfer.service.js";

/**
 * Importing a bank's CSV export (Wells Fargo, Chase, Bank of America, ...) into an account the user
 * keeps by hand. Banks label their columns differently, so they are found by name: a date, a
 * description, and either one signed amount or separate debit and credit columns; a status column
 * marks pending rows. Wells Fargo's older export has no header row (date, amount, *, check number,
 * description) and is recognised by its shape.
 *
 * In the file, money into the account is positive (the banks' own convention); `flip` reverses that
 * for files that show charges as positive, as many card exports do. Rows already on the account
 * (the same date, amount and description) are skipped, so importing the same file again adds
 * nothing.
 */

export interface BankCsvRow {
  /** Line in the file, for messages. */
  line: number;
  date: string;
  description: string;
  /** Positive when money comes into the account. */
  amountMinor: number;
  pending: boolean;
  /** Already on the account: skipped. */
  duplicate: boolean;
}

export interface BankCsvResult {
  /** How the columns were read, in words. */
  format: string;
  rows: BankCsvRow[];
  added: number;
  duplicates: number;
  /** Rows with no amount (such as a zero-dollar notice), left out. */
  skipped: number;
  /** The account's balance before, and after (or, in a preview, after an import). */
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
}

export interface BankCsvOptions {
  /** The file shows money out as positive. */
  flip?: boolean | undefined;
  /**
   * Keep the account's balance as it is: the imported rows are history the balance already
   * includes, so the opening balance is moved back by what they add up to.
   */
  keepBalance?: boolean | undefined;
  /** Only read the file and report; change nothing. */
  dryRun?: boolean | undefined;
}

const MONTHS = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

/** `MM/DD/YYYY`, `M/D/YY` or `YYYY-MM-DD` as `YYYY-MM-DD`, or null. */
export function readBankDate(raw: string): string | null {
  const text = raw.trim();
  if (isRealDate(text)) return text;
  const m = MONTHS.exec(text);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  const date = `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return isRealDate(date) ? date : null;
}

const fail = (message: string): never => {
  throw new AppError(400, "invalid_csv", message);
};

const find = (headers: string[], pattern: RegExp): number =>
  headers.findIndex((h) => pattern.test(h));

interface Columns {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  status: number;
  check: number;
  header: boolean;
  format: string;
}

function columnsOf(table: string[][]): Columns {
  const first = table[0]!;
  // No header: Wells Fargo's older export, `"date","-12.34","*","","DESCRIPTION"`.
  if (readBankDate(first[0] ?? "") !== null) {
    if (first.length >= 5 && /^[-+(]?\$?[\d,.]+\)?$/.test((first[1] ?? "").trim())) {
      return {
        date: 0,
        amount: 1,
        check: 3,
        description: 4,
        debit: -1,
        credit: -1,
        status: -1,
        header: false,
        format: "Wells Fargo (no header row)",
      };
    }
    fail("The file has no header row, and its columns could not be recognised.");
  }
  const headers = first.map((h) => h.trim().toLowerCase());
  const date =
    find(headers, /^(transaction |trans\.? |posting |posted )?date$/) >= 0
      ? find(headers, /^(transaction |trans\.? |posting |posted )?date$/)
      : find(headers, /date/);
  const description = find(headers, /description|memo|payee|details|merchant|^name$/);
  const amount = find(headers, /^amount/);
  const debit = find(headers, /debit|withdrawal|money out/);
  const credit = find(headers, /credit|deposit|money in/);
  if (date < 0) fail(`The file needs a date column. Found: ${headers.join(", ")}.`);
  if (description < 0) fail(`The file needs a description column. Found: ${headers.join(", ")}.`);
  if (amount < 0 && (debit < 0 || credit < 0)) {
    fail(
      `The file needs an amount column, or debit and credit columns. Found: ${headers.join(", ")}.`,
    );
  }
  return {
    date,
    description,
    amount,
    debit: amount >= 0 ? -1 : debit,
    credit: amount >= 0 ? -1 : credit,
    status: find(headers, /status/),
    check: find(headers, /check|chk/),
    header: true,
    format:
      amount >= 0
        ? `columns "${first[date]}", "${first[description]}", "${first[amount]}"`
        : `columns "${first[date]}", "${first[description]}", "${first[debit]}" and "${first[credit]}"`,
  };
}

/** Reads the rows of a bank's CSV export. Throws, naming the lines, if any row can't be read. */
export function parseBankCsv(
  csv: string,
  flip = false,
): { format: string; rows: Omit<BankCsvRow, "duplicate">[]; skipped: number } {
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (e) {
    return fail(`The file could not be read: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  if (table.length === 0) fail("The file is empty.");
  const cols = columnsOf(table);
  const body = cols.header ? table.slice(1) : table;
  const problems: string[] = [];
  const rows: Omit<BankCsvRow, "duplicate">[] = [];
  let skipped = 0;
  body.forEach((cells, i) => {
    const line = i + (cols.header ? 2 : 1);
    const cell = (index: number) => (index >= 0 ? (cells[index] ?? "").trim() : "");
    const date = readBankDate(cell(cols.date));
    if (!date) {
      problems.push(`line ${line}: "${cell(cols.date)}" is not a date`);
      return;
    }
    let amount: number | null;
    try {
      if (cols.amount >= 0) amount = parseNumberCell(cell(cols.amount));
      else {
        const credit = parseNumberCell(cell(cols.credit));
        const debit = parseNumberCell(cell(cols.debit));
        amount =
          credit === null && debit === null ? null : Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
      }
    } catch (e) {
      problems.push(`line ${line}: ${e instanceof Error ? e.message : "the amount can't be read"}`);
      return;
    }
    const minor = amount === null ? 0 : Math.round(amount * 100) * (flip ? -1 : 1);
    if (minor === 0) {
      skipped += 1;
      return;
    }
    const check = cell(cols.check).replace(/^\*$/, "");
    const description =
      cell(cols.description).replace(/\s+/g, " ") || (check ? `Check #${check}` : "Unknown");
    rows.push({
      line,
      date,
      description,
      amountMinor: minor,
      pending: /pending/i.test(cell(cols.status)),
    });
  });
  if (problems.length > 0) {
    fail(
      `Nothing was imported. ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}.`,
    );
  }
  if (rows.length === 0) fail("The file has no transactions.");
  return { format: cols.format, rows, skipped };
}

/** Imports a bank's CSV export into an account kept by hand (or, with dryRun, only reports). */
export function importBankCsv(
  db: AppDb,
  accountId: number,
  csv: string,
  options: BankCsvOptions = {},
  now = new Date().toISOString(),
): BankCsvResult {
  const account = db
    .select({
      id: accounts.id,
      type: accounts.type,
      subtype: accounts.subtype,
      isManual: accounts.isManual,
      currency: accounts.currency,
      balance: accounts.currentBalanceMinor,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) throw notFound("That account");
  if (
    !account.isManual ||
    (account.type !== "depository" && account.type !== "credit" && account.type !== "loan") ||
    account.subtype === STORE_CREDIT_SUBTYPE
  ) {
    throw new AppError(
      409,
      "not_manual_account",
      "Only an account you keep by hand, such as a checking account, can import a bank's file.",
    );
  }
  const parsed = parseBankCsv(csv, options.flip ?? false);

  // What is already on the account, by date, amount (stored the bank's way: out is positive) and
  // description; each existing row stands for one row of the file.
  const existing = new Map<string, number>();
  for (const t of db
    .select({ date: transactions.date, amount: transactions.amountMinor, name: transactions.name })
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all()) {
    const key = `${t.date}|${t.amount}|${t.name.trim().toLowerCase()}`;
    existing.set(key, (existing.get(key) ?? 0) + 1);
  }
  const rows: BankCsvRow[] = parsed.rows.map((r) => {
    const key = `${r.date}|${-r.amountMinor}|${r.description.toLowerCase()}`;
    const left = existing.get(key) ?? 0;
    if (left > 0) existing.set(key, left - 1);
    return { ...r, duplicate: left > 0 };
  });
  const fresh = rows.filter((r) => !r.duplicate);
  // Money in raises a deposit account and lowers what a card owes.
  const net = fresh.filter((r) => !r.pending).reduce((n, r) => n + r.amountMinor, 0);
  const change = options.keepBalance ? 0 : account.type === "credit" ? -net : net;
  const balanceBefore = account.balance ?? 0;
  const result: BankCsvResult = {
    format: parsed.format,
    rows,
    added: options.dryRun ? 0 : fresh.length,
    duplicates: rows.length - fresh.length,
    skipped: parsed.skipped,
    balanceBeforeMinor: balanceBefore,
    balanceAfterMinor: balanceBefore + change,
  };
  if (options.dryRun || fresh.length === 0) return result;

  db.transaction((tx) => {
    const ids: number[] = [];
    for (const r of fresh) {
      ids.push(
        tx
          .insert(transactions)
          .values({
            accountId,
            date: r.date,
            name: r.description,
            merchantName: r.description,
            amountMinor: -r.amountMinor,
            currency: account.currency,
            pending: r.pending,
            source: "manual",
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: transactions.id })
          .get().id,
      );
    }
    if (options.keepBalance) {
      // The balance already includes this history: start the account earlier by what it adds up
      // to, dated the day before the first imported row.
      const first = fresh.map((r) => r.date).sort()[0]!;
      const start = new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const opening = tx
        .select({ id: transactions.id, amount: transactions.amountMinor, date: transactions.date })
        .from(transactions)
        .where(
          and(eq(transactions.accountId, accountId), eq(transactions.transferSource, "system")),
        )
        .get();
      if (opening) {
        tx.update(transactions)
          .set({
            amountMinor: opening.amount + net,
            date: opening.date < start ? opening.date : start,
            updatedAt: now,
          })
          .where(eq(transactions.id, opening.id))
          .run();
      } else {
        tx.insert(transactions)
          .values({
            accountId,
            date: start,
            name: OPENING_BALANCE_NAME,
            merchantName: OPENING_BALANCE_NAME,
            amountMinor: net,
            currency: account.currency,
            pending: false,
            isTransfer: true,
            transferSource: "system",
            source: "manual",
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      // An opening balance of exactly zero is no opening balance.
      tx.delete(transactions)
        .where(
          and(
            eq(transactions.accountId, accountId),
            eq(transactions.transferSource, "system"),
            sql`${transactions.amountMinor} = 0`,
          ),
        )
        .run();
    }
    applyRules(tx, ids);
    recomputeManualBalance(tx, accountId, now);
  });
  detectInternalTransfers(db, now);
  result.balanceAfterMinor =
    db
      .select({ b: accounts.currentBalanceMinor })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get()?.b ?? result.balanceAfterMinor;
  return result;
}
