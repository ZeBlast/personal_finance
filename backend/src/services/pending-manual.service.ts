import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { accountScope } from "./account-scope.js";

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
  }>(sql`
    select t.id, t.account_id as accountId, a.type as accountType, t.date,
      coalesce(t.merchant_name_user, t.merchant_name, t.name) as merchant, t.amount_minor as amountMinor
    from transactions t join accounts a on a.id = t.account_id
    where t.source = 'manual' and t.pending = 1 and a.is_manual = 1
      and a.type in ('depository', 'credit') and ${accountScope(options.accountId)}
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
