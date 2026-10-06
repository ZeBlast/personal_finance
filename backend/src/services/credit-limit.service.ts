import { and, asc, desc, eq, lte } from "drizzle-orm";
import { accounts, creditLimitHistory } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";

export interface CreditLimitEntry {
  id: number;
  limitMinor: number;
  currency: string;
  effectiveDate: string;
  source: string;
  note: string | null;
  /** Change from the previous entry, or null for the first one. */
  changeMinor: number | null;
  changePercent: number | null;
}

type Reader = Pick<AppDb, "select">;
type Writer = Pick<AppDb, "select" | "insert">;

export interface CreditLimitHistoryView {
  current: { limitMinor: number; effectiveDate: string; source: string } | null;
  entries: CreditLimitEntry[];
}

/** The current limit and every entry, as the API returns them. */
export function creditLimitView(db: Reader, accountId: number): CreditLimitHistoryView {
  const today = new Date().toISOString().slice(0, 10);
  const current = currentCreditLimit(db, accountId, today);
  return {
    current: current
      ? {
          limitMinor: current.limitMinor,
          effectiveDate: current.effectiveDate,
          source: current.source,
        }
      : null,
    entries: creditLimitHistoryFor(db, accountId),
  };
}

function requireDate(date: string): void {
  if (!isRealDate(date)) {
    throw new AppError(400, "invalid_date", "Enter a real date as YYYY-MM-DD.");
  }
}

/**
 * Adds a limit by hand. The date may be in the past (to record a change that already happened) or
 * in the future (it takes effect on that day). Sync never edits or deletes these.
 */
export function addManualCreditLimit(
  db: AppDb,
  accountId: number,
  input: { limitMinor: number; effectiveDate: string; note?: string | null | undefined },
): CreditLimitHistoryView {
  const account = db
    .select({ type: accounts.type, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) throw notFound("That account");
  if (account.type !== "credit") {
    throw new AppError(
      400,
      "not_credit_account",
      "Credit limits can only be added to credit accounts.",
    );
  }
  requireDate(input.effectiveDate);
  const now = new Date().toISOString();
  db.insert(creditLimitHistory)
    .values({
      accountId,
      limitMinor: input.limitMinor,
      currency: account.currency,
      effectiveDate: input.effectiveDate,
      source: "manual",
      note: input.note?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return creditLimitView(db, accountId);
}

/**
 * Edits an entry. Changing the amount makes it a manual entry (it is now the user's number, not
 * the bank's). Changing only the date or note keeps an observed entry observed: the date the app
 * noticed a change is often not the day the bank made it, so correcting it is expected.
 */
export function updateCreditLimitEntry(
  db: AppDb,
  entryId: number,
  patch: {
    limitMinor?: number | undefined;
    effectiveDate?: string | undefined;
    note?: string | null | undefined;
  },
): CreditLimitHistoryView {
  const entry = db
    .select()
    .from(creditLimitHistory)
    .where(eq(creditLimitHistory.id, entryId))
    .get();
  if (!entry) throw notFound("That credit limit entry");
  if (patch.effectiveDate !== undefined) requireDate(patch.effectiveDate);
  const amountChanged = patch.limitMinor !== undefined && patch.limitMinor !== entry.limitMinor;
  db.update(creditLimitHistory)
    .set({
      ...(patch.limitMinor === undefined ? {} : { limitMinor: patch.limitMinor }),
      ...(patch.effectiveDate === undefined ? {} : { effectiveDate: patch.effectiveDate }),
      ...(patch.note === undefined ? {} : { note: patch.note?.trim() || null }),
      ...(amountChanged ? { source: "manual" } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(creditLimitHistory.id, entryId))
    .run();
  return creditLimitView(db, entry.accountId);
}

/**
 * Deletes an entry; the current limit and every change figure are recalculated from what remains.
 * If the bank still reports a limit that no remaining entry matches, the next sync notes it again.
 */
export function deleteCreditLimitEntry(db: AppDb, entryId: number): CreditLimitHistoryView {
  const entry = db
    .select({ accountId: creditLimitHistory.accountId })
    .from(creditLimitHistory)
    .where(eq(creditLimitHistory.id, entryId))
    .get();
  if (!entry) throw notFound("That credit limit entry");
  db.delete(creditLimitHistory).where(eq(creditLimitHistory.id, entryId)).run();
  return creditLimitView(db, entry.accountId);
}

/** The current limit: the entry with the latest effective date that is not in the future. */
export function currentCreditLimit(db: Reader, accountId: number, today: string) {
  return (
    db
      .select()
      .from(creditLimitHistory)
      .where(
        and(
          eq(creditLimitHistory.accountId, accountId),
          lte(creditLimitHistory.effectiveDate, today),
        ),
      )
      .orderBy(desc(creditLimitHistory.effectiveDate), desc(creditLimitHistory.id))
      .get() ?? null
  );
}

/** Every entry for an account, newest first, each with its change from the previous entry. */
export function creditLimitHistoryFor(db: Reader, accountId: number): CreditLimitEntry[] {
  const chronological = db
    .select()
    .from(creditLimitHistory)
    .where(eq(creditLimitHistory.accountId, accountId))
    .orderBy(asc(creditLimitHistory.effectiveDate), asc(creditLimitHistory.id))
    .all();

  const entries = chronological.map((row, index): CreditLimitEntry => {
    const previous = chronological[index - 1];
    const change = previous ? row.limitMinor - previous.limitMinor : null;
    return {
      id: row.id,
      limitMinor: row.limitMinor,
      currency: row.currency,
      effectiveDate: row.effectiveDate,
      source: row.source,
      note: row.note,
      changeMinor: change,
      changePercent:
        previous && previous.limitMinor > 0 && change !== null
          ? Math.round((change / previous.limitMinor) * 1000) / 10
          : null,
    };
  });
  return entries.reverse();
}

/**
 * Records a limit reported by the provider, but only if it differs from the current one. The date
 * is when the app noticed the change (the bank may have made it earlier), so the entry is
 * labelled as observed. Manual entries are never touched. Returns true when an entry was added.
 */
export function observeCreditLimit(
  db: Writer,
  accountId: number,
  limitMinor: number,
  currency: string,
  today: string,
  nowIso: string,
): boolean {
  const current = currentCreditLimit(db, accountId, today);
  if (current && current.limitMinor === limitMinor) return false;
  db.insert(creditLimitHistory)
    .values({
      accountId,
      limitMinor,
      currency,
      effectiveDate: today,
      source: "plaid",
      note: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();
  return true;
}
