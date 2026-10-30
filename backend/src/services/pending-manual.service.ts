import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { accountScope } from "./account-scope.js";

/**
 * The day a pending manual entry is expected to take effect: its own date when that is still to
 * come, otherwise tomorrow (it has not posted yet, so it can only land from tomorrow on).
 */
export function projectedDate(date: string, today: string): string {
  return date > today ? date : addDays(today, 1);
}

/** Outstanding manual entries are projected separately from posted account balances. */
export function pendingManualTransactions(
  db: AppDb,
  options: { from?: string; to: string; currency: string; accountId?: number | undefined },
) {
  return db.all<{
    id: number;
    accountId: number;
    accountType: string;
    date: string;
    merchant: string;
    amountMinor: number;
    accountName: string;
    categoryName: string | null;
  }>(sql`
    select t.id, t.account_id as accountId, a.type as accountType, t.date,
      coalesce(t.merchant_name_user, t.merchant_name, t.name) as merchant, t.amount_minor as amountMinor,
      a.name as accountName, c.name as categoryName
    from transactions t join accounts a on a.id = t.account_id
      left join categories c on c.id = t.category_id
    where t.source = 'manual' and t.pending = 1 and a.is_manual = 1
      and a.type in ('depository', 'credit', 'loan') and ${accountScope(options.accountId)}
      and t.currency = ${options.currency} and t.date <= ${options.to}
      ${options.from === undefined ? sql`` : sql`and t.date >= ${options.from}`}
      ${options.accountId === undefined ? sql`` : sql`and t.account_id = ${options.accountId}`}
    order by t.date, t.id`);
}

/** An actual pending entry takes the place of an otherwise identical planned occurrence. */
export function matchesPendingManual(
  pending: ReturnType<typeof pendingManualTransactions>,
  occurrence: {
    date: string;
    merchant: string;
    amountMinor: number;
    direction: "in" | "out";
    accountId: number | null;
  },
): boolean {
  const amount = occurrence.direction === "out" ? occurrence.amountMinor : -occurrence.amountMinor;
  return pending.some(
    (t) =>
      t.date === occurrence.date &&
      t.amountMinor === amount &&
      (occurrence.accountId === null || t.accountId === occurrence.accountId) &&
      t.merchant.trim().toLowerCase() === occurrence.merchant.trim().toLowerCase(),
  );
}
