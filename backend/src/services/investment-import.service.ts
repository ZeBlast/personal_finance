import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { investmentTransactions, securities } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import type { InvestmentTransactionKind } from "../plaid/gateway.js";
import { parseCsv, parseNumberCell } from "../utils/csv.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { toMinorUnits } from "../utils/money.js";
import {
  requireManualInvestmentAccount,
  setManualHoldings,
  upsertManualSecurity,
  type ManualHoldingInput,
} from "./investment.service.js";

/**
 * Importing from CSV for accounts Plaid cannot connect (such as the Thrift Savings Plan).
 * Both file kinds are safe to import again: holdings REPLACE what the account holds, and
 * transactions are fingerprinted so a row already imported is skipped.
 *
 * Holdings file columns (header row required, any order, case does not matter):
 *   symbol or name   (at least one; TSP funds are recognized as "G Fund", "TSP-C", "L 2050", ...)
 *   quantity         (also accepted: shares)
 *   price            (per unit)                 value (also: market_value) -- one of the two
 *   cost_basis       (total paid; optional)     asset_class (Stocks, Bonds, Cash, Funds, Crypto, Other)
 *   as_of            (YYYY-MM-DD; optional)
 *   Optional detail: isin, cusip, sedol, sector, industry, subtype, vested_quantity, vested_value,
 *   price_as_of (the date of the price, YYYY-MM-DD).
 *
 * Transactions file columns:
 *   date (YYYY-MM-DD), type (buy, sell, dividend, interest, contribution, withdrawal, fee,
 *   transfer, other), amount, and optionally symbol, name, quantity, price, fees, description,
 *   subtype (a finer label such as "employer match") and datetime (YYYY-MM-DDTHH:MM).
 *   `amount` is the cash involved as a POSITIVE number; the type decides the direction. For
 *   `transfer` and `other`, use a positive amount for money in and a negative one for money out.
 */

const MAX_ROWS = 5000;
const MAX_REPORTED_PROBLEMS = 5;

export const TRANSACTION_TYPES: readonly InvestmentTransactionKind[] = [
  "buy",
  "sell",
  "dividend",
  "interest",
  "contribution",
  "withdrawal",
  "fee",
  "transfer",
  "other",
];

/** Types whose direction is fixed: cash goes out for these... */
const CASH_OUT = new Set<InvestmentTransactionKind>(["buy", "fee", "withdrawal"]);
/** ...and comes in for these. `transfer` and `other` use the sign of the amount. */
const CASH_IN = new Set<InvestmentTransactionKind>([
  "sell",
  "dividend",
  "interest",
  "contribution",
]);

export function isTransactionType(value: string): value is InvestmentTransactionKind {
  return (TRANSACTION_TYPES as readonly string[]).includes(value);
}

/** Converts what a person types (positive = the type's own direction) to the stored sign. */
export function storedAmountMinor(kind: InvestmentTransactionKind, enteredMinor: number): number {
  if (CASH_OUT.has(kind)) return enteredMinor;
  if (CASH_IN.has(kind)) return -enteredMinor;
  return -enteredMinor; // transfer / other: positive entered = money in = negative stored
}

type Db = Pick<AppDb, "select" | "insert" | "update" | "delete">;
type Row = Record<string, string>;

function readTable(csv: string): { rows: Array<{ line: number; cells: Row }>; headers: string[] } {
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (error) {
    throw new AppError(400, "invalid_csv", error instanceof Error ? error.message : "Bad file.");
  }
  if (table.length === 0) throw new AppError(400, "invalid_csv", "The file is empty.");
  if (table.length - 1 > MAX_ROWS) {
    throw new AppError(400, "invalid_csv", `The file has more than ${MAX_ROWS} rows.`);
  }
  const headers = table[0]!.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const rows = table.slice(1).map((cells, index) => ({
    line: index + 2,
    cells: Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()])) as Row,
  }));
  return { rows, headers };
}

/** The first of these columns that exists in the file. */
const pick = (row: Row, ...names: string[]): string => {
  for (const name of names) if (row[name] !== undefined && row[name] !== "") return row[name]!;
  return "";
};

function requireColumns(headers: string[], needAnyOf: string[][], what: string): void {
  for (const group of needAnyOf) {
    if (!group.some((name) => headers.includes(name))) {
      throw new AppError(
        400,
        "invalid_csv",
        `The ${what} file needs a "${group.join('" or "')}" column. Found: ${headers.join(", ") || "none"}.`,
      );
    }
  }
}

function fail(problems: string[]): never {
  const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).join(" ");
  const more =
    problems.length > MAX_REPORTED_PROBLEMS
      ? ` (and ${problems.length - MAX_REPORTED_PROBLEMS} more)`
      : "";
  throw new AppError(400, "invalid_csv", `Nothing was imported. ${shown}${more}`);
}

function cell<T>(line: number, problems: string[], read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    problems.push(`Row ${line}: ${error instanceof Error ? error.message : "unreadable."}`);
    return fallback;
  }
}

/** Replaces a manual account's holdings with the contents of a CSV file. */
export function importHoldingsCsv(
  db: AppDb,
  accountId: number,
  csv: string,
  now: string,
): { count: number; totalMinor: number } {
  requireManualInvestmentAccount(db, accountId);
  const { rows, headers } = readTable(csv);
  requireColumns(
    headers,
    [
      ["symbol", "name"],
      ["quantity", "shares"],
    ],
    "holdings",
  );
  if (!headers.some((h) => ["price", "value", "market_value"].includes(h))) {
    throw new AppError(
      400,
      "invalid_csv",
      'The holdings file needs a "price" or a "value" column so each position can be valued.',
    );
  }
  const problems: string[] = [];
  const parsed: ManualHoldingInput[] = [];
  for (const { line, cells } of rows) {
    const quantity = cell(
      line,
      problems,
      () => parseNumberCell(pick(cells, "quantity", "shares")),
      null,
    );
    if (quantity === null) {
      problems.push(`Row ${line}: the quantity is missing.`);
      continue;
    }
    const price = cell(line, problems, () => parseNumberCell(pick(cells, "price")), null);
    const value = cell(
      line,
      problems,
      () => parseNumberCell(pick(cells, "value", "market_value")),
      null,
    );
    const cost = cell(
      line,
      problems,
      () => parseNumberCell(pick(cells, "cost_basis", "cost")),
      null,
    );
    const asOf = pick(cells, "as_of", "date");
    if (asOf && !isRealDate(asOf)) {
      problems.push(`Row ${line}: "${asOf}" is not a date (use YYYY-MM-DD).`);
      continue;
    }
    const vestedQuantity = cell(
      line,
      problems,
      () => parseNumberCell(pick(cells, "vested_quantity", "vested_shares")),
      null,
    );
    const vestedValue = cell(
      line,
      problems,
      () => parseNumberCell(pick(cells, "vested_value")),
      null,
    );
    const priceAsOf = pick(cells, "price_as_of", "price_date");
    if (priceAsOf && !isRealDate(priceAsOf)) {
      problems.push(`Row ${line}: "${priceAsOf}" is not a date (use YYYY-MM-DD).`);
      continue;
    }
    parsed.push({
      symbol: pick(cells, "symbol") || null,
      name: pick(cells, "name") || null,
      assetClass: normalizeClass(pick(cells, "asset_class", "class")),
      quantity,
      price,
      valueMinor: value === null ? null : toMinorUnits(value, "USD"),
      costBasisMinor: cost === null ? null : toMinorUnits(cost, "USD"),
      asOf: asOf || null,
      vestedQuantity,
      vestedValueMinor: vestedValue === null ? null : toMinorUnits(vestedValue, "USD"),
      priceAsOf: priceAsOf || null,
      detail: {
        isin: pick(cells, "isin"),
        cusip: pick(cells, "cusip"),
        sedol: pick(cells, "sedol"),
        sector: pick(cells, "sector"),
        industry: pick(cells, "industry"),
        subtype: pick(cells, "subtype", "security_subtype"),
      },
    });
  }
  if (problems.length > 0) fail(problems);
  if (parsed.length === 0) fail(["The file has a header but no rows."]);
  try {
    const result = setManualHoldings(db, accountId, parsed, now);
    return { count: result.count, totalMinor: result.totalMinor };
  } catch (error) {
    if (error instanceof AppError) fail([error.message]);
    throw error;
  }
}

/** "stocks", "STOCK", "bond" and so on, matched to the class names; blank stays blank. */
function normalizeClass(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const match = ["Stocks", "Bonds", "Cash", "Funds", "Crypto", "Other"].find(
    (c) =>
      c.toLowerCase() === t ||
      c.toLowerCase() === `${t}s` ||
      c.toLowerCase() === t.replace(/s$/, ""),
  );
  return match ?? text.trim(); // an unknown word is passed on and rejected with a clear message
}

export interface ManualTransactionInput {
  date: string;
  type: string;
  symbol?: string | null | undefined;
  name?: string | null | undefined;
  quantity?: number | null | undefined;
  price?: number | null | undefined;
  /** Positive cash amount in minor units (see the sign note at the top of this file). */
  amountMinor?: number | null | undefined;
  feesMinor?: number | null | undefined;
  description?: string | null | undefined;
  /** A finer label than the type, such as "employer match" or "loan repayment". */
  subtype?: string | null | undefined;
  /** The time of day, when known (YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]). */
  datetime?: string | null | undefined;
}

interface Prepared {
  date: string;
  kind: InvestmentTransactionKind;
  securityId: number | null;
  name: string;
  quantity: number | null;
  price: number | null;
  amountMinor: number;
  feesMinor: number | null;
  subtype: string | null;
  datetime: string | null;
}

function prepare(db: Db, input: ManualTransactionInput, currency: string, now: string): Prepared {
  const kind = input.type.trim().toLowerCase();
  if (!isTransactionType(kind)) {
    throw new AppError(
      400,
      "invalid_type",
      `"${input.type}" is not a transaction type. Use one of: ${TRANSACTION_TYPES.join(", ")}.`,
    );
  }
  if (!isRealDate(input.date)) {
    throw new AppError(400, "invalid_date", `"${input.date}" is not a date (use YYYY-MM-DD).`);
  }
  let entered = input.amountMinor ?? null;
  if (entered === null && input.quantity != null && input.price != null) {
    entered = toMinorUnits(input.quantity * input.price, currency);
  }
  if (entered === null) {
    throw new AppError(400, "invalid_amount", "Give an amount, or a quantity and a price.");
  }
  if ((CASH_OUT.has(kind) || CASH_IN.has(kind)) && entered < 0) {
    throw new AppError(
      400,
      "invalid_amount",
      `Enter the ${kind} amount as a positive number; the type already says which way the cash moves.`,
    );
  }
  const securityId =
    input.symbol?.trim() || input.name?.trim()
      ? upsertManualSecurity(db, { symbol: input.symbol, name: input.name, currency }, now)
      : null;
  const security = securityId
    ? db
        .select({ name: securities.name })
        .from(securities)
        .where(eq(securities.id, securityId))
        .get()
    : undefined;
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return {
    date: input.date,
    kind,
    securityId,
    name: input.description?.trim() || (security ? `${label} ${security.name}` : label),
    quantity: input.quantity ?? null,
    price: input.price ?? null,
    amountMinor: storedAmountMinor(kind, entered),
    feesMinor: input.feesMinor ?? null,
    subtype: input.subtype?.trim().slice(0, 80) || null,
    datetime: checkedDatetime(input.datetime),
  };
}

/** A date with an optional time, as typed; anything else is refused with a clear message. */
function checkedDatetime(text: string | null | undefined): string | null {
  const value = text?.trim() ?? "";
  if (value === "") return null;
  if (
    !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(value) ||
    !isRealDate(value.slice(0, 10))
  ) {
    throw new AppError(
      400,
      "invalid_datetime",
      `"${value}" is not a date and time (use YYYY-MM-DD or YYYY-MM-DDTHH:MM).`,
    );
  }
  return value;
}

function fingerprint(accountId: number, p: Prepared, occurrence: number): string {
  return crypto
    .createHash("sha1")
    .update(
      [
        accountId,
        p.date,
        p.kind,
        p.securityId ?? "",
        p.quantity ?? "",
        p.amountMinor,
        occurrence,
      ].join("|"),
    )
    .digest("hex");
}

function insertPrepared(
  db: Db,
  accountId: number,
  currency: string,
  p: Prepared,
  importKey: string,
  now: string,
): boolean {
  const result = db
    .insert(investmentTransactions)
    .values({
      accountId,
      securityId: p.securityId,
      importKey,
      date: p.date,
      type: p.kind,
      name: p.name,
      quantity: p.quantity,
      price: p.price,
      amountMinor: p.amountMinor,
      feesMinor: p.feesMinor,
      currency,
      subtype: p.subtype,
      transactionDatetime: p.datetime,
      source: "manual",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: investmentTransactions.importKey })
    .run();
  return result.changes > 0;
}

/** Adds one transaction by hand. */
export function addManualTransaction(
  db: AppDb,
  accountId: number,
  input: ManualTransactionInput,
  now: string,
): number {
  const account = requireManualInvestmentAccount(db, accountId);
  return db.transaction((tx) => {
    const prepared = prepare(tx, input, account.currency, now);
    const key = `manual:${crypto.randomUUID()}`;
    insertPrepared(tx, accountId, account.currency, prepared, key, now);
    return tx
      .select({ id: investmentTransactions.id })
      .from(investmentTransactions)
      .where(eq(investmentTransactions.importKey, key))
      .get()!.id;
  });
}

/** Deletes a transaction that was entered or imported by hand. */
export function deleteManualTransaction(db: AppDb, id: number): void {
  const row = db
    .select({ id: investmentTransactions.id, source: investmentTransactions.source })
    .from(investmentTransactions)
    .where(eq(investmentTransactions.id, id))
    .get();
  if (!row) throw notFound("That transaction");
  if (row.source !== "manual") {
    throw new AppError(409, "not_manual", "Only transactions entered by hand can be deleted.");
  }
  db.delete(investmentTransactions).where(eq(investmentTransactions.id, id)).run();
}

/** Imports transactions from CSV. Rows already imported before are skipped. */
export function importTransactionsCsv(
  db: AppDb,
  accountId: number,
  csv: string,
  now: string,
): { added: number; skipped: number } {
  const account = requireManualInvestmentAccount(db, accountId);
  const { rows, headers } = readTable(csv);
  requireColumns(headers, [["date"], ["type"]], "transactions");
  if (!headers.some((h) => ["amount", "quantity"].includes(h))) {
    throw new AppError(400, "invalid_csv", 'The transactions file needs an "amount" column.');
  }
  const problems: string[] = [];
  const inputs: Array<{ line: number; input: ManualTransactionInput }> = [];
  for (const { line, cells } of rows) {
    const amount = cell(line, problems, () => parseNumberCell(pick(cells, "amount")), null);
    const quantity = cell(
      line,
      problems,
      () => parseNumberCell(pick(cells, "quantity", "shares")),
      null,
    );
    const price = cell(line, problems, () => parseNumberCell(pick(cells, "price")), null);
    const fees = cell(line, problems, () => parseNumberCell(pick(cells, "fees", "fee")), null);
    inputs.push({
      line,
      input: {
        date: pick(cells, "date"),
        type: pick(cells, "type"),
        symbol: pick(cells, "symbol") || null,
        name: pick(cells, "name") || null,
        description: pick(cells, "description") || null,
        quantity,
        price,
        amountMinor: amount === null ? null : toMinorUnits(amount, account.currency),
        feesMinor: fees === null ? null : toMinorUnits(fees, account.currency),
        subtype: pick(cells, "subtype") || null,
        datetime: pick(cells, "datetime", "time") || null,
      },
    });
  }
  if (problems.length > 0) fail(problems);
  if (inputs.length === 0) fail(["The file has a header but no rows."]);

  try {
    return db.transaction((tx) => {
      const counts = new Map<string, number>();
      let added = 0;
      let skipped = 0;
      for (const { line, input } of inputs) {
        let prepared: Prepared;
        try {
          prepared = prepare(tx, input, account.currency, now);
        } catch (error) {
          if (error instanceof AppError) problems.push(`Row ${line}: ${error.message}`);
          else throw error;
          continue;
        }
        // Identical rows in one file are all kept (two equal purchases on one day are possible);
        // the occurrence number keeps them distinct from each other but stable between imports.
        const base = fingerprint(accountId, prepared, 0);
        const occurrence = counts.get(base) ?? 0;
        counts.set(base, occurrence + 1);
        const key = fingerprint(accountId, prepared, occurrence);
        if (insertPrepared(tx, accountId, account.currency, prepared, key, now)) added += 1;
        else skipped += 1;
      }
      if (problems.length > 0) throw new AppError(400, "invalid_csv", "Rolled back.");
      return { added, skipped };
    });
  } catch (error) {
    if (problems.length > 0) fail(problems);
    throw error;
  }
}
