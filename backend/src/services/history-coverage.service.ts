import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { addDays, lastOfMonth } from "../utils/dates.js";
import { countedAccount } from "./account-scope.js";

/**
 * How far back, and how far forward, the app's records of one account can be trusted. A hand-kept
 * account starts at its first entry; a connected one starts as far back as the bank was asked for;
 * and a connected account's records stop where its last good sync (or the bank sharing it) did.
 */

/** The first day the app has records for this account; null when it has no transactions. */
export function historyStart(db: AppDb, accountId: number): string | null {
  const row = db.get<{
    first: string | null;
    created: string | null;
    days: number | null;
  }>(sql`
    select
      (select min(date) from transactions where account_id = ${accountId}) as first,
      p.created_at as created, p.days_requested as days
    from accounts a left join plaid_items p on p.id = a.plaid_item_id
    where a.id = ${accountId}`);
  if (!row?.first) return null;
  if (!row.created || row.days === null) return row.first;
  const asked = addDays(row.created.slice(0, 10), -row.days);
  return asked < row.first ? asked : row.first;
}

export type CoverageReason = "not_synced" | "no_longer_shared";

export interface AccountCoverage {
  from: string | null;
  /** The last day the records cover; null when they are up to date (a hand-kept account). */
  through: string | null;
  reason: CoverageReason | null;
}

export function accountCoverage(db: AppDb, accountId: number): AccountCoverage {
  const row = db.get<{ gone: string | null; item: number | null; synced: string | null }>(sql`
    select a.no_longer_shared_at as gone, a.plaid_item_id as item, p.last_successful_sync_at as synced
    from accounts a left join plaid_items p on p.id = a.plaid_item_id
    where a.id = ${accountId}`);
  const from = historyStart(db, accountId);
  if (row?.gone) return { from, through: row.gone.slice(0, 10), reason: "no_longer_shared" };
  if (row?.item !== null && row?.item !== undefined) {
    // A connection that has never synced has covered nothing yet.
    const through = row.synced ? row.synced.slice(0, 10) : addDays(from ?? "0001-01-02", -1);
    return { from, through, reason: "not_synced" };
  }
  return { from, through: null, reason: null };
}

/**
 * Whether the records for a whole month can be trusted. An account counts only for the months it
 * touches: one whose history begins after the month, or whose coverage ended before it, is left
 * out. The month in which an account starts or stops is incomplete, and so is a month no account
 * has records for. Pure.
 */
export function isMonthComplete(
  month: string,
  coverage: Array<{ from: string | null; through: string | null }>,
): boolean {
  const first = `${month}-01`;
  const last = lastOfMonth(month);
  const touching = coverage.filter(
    (c) => c.from !== null && c.from <= last && (c.through === null || c.through >= first),
  );
  return (
    touching.length > 0 &&
    touching.every((c) => c.from! <= first && (c.through === null || c.through >= last))
  );
}

/** An account left out of a baseline because its records stopped before a month it looks at. */
export interface LeftOutAccount {
  name: string;
  /** The last day its records cover. */
  through: string;
}

export interface CompleteMonths {
  months: Set<string>;
  leftOut: LeftOutAccount[];
}

/** Which of these months are complete for the accounts that count (or for the one account). */
export function completeMonths(
  db: AppDb,
  months: string[],
  scope: { environment: string; accountId?: number },
): CompleteMonths {
  const accounts =
    scope.accountId !== undefined
      ? db.all<{ id: number; name: string }>(
          sql`select id, name from accounts where id = ${scope.accountId}`,
        )
      : db.all<{ id: number; name: string }>(
          sql`select a.id, a.name from accounts a left join plaid_items p on p.id = a.plaid_item_id
              where ${countedAccount("a")}
                and (a.plaid_item_id is null or p.environment = ${scope.environment})`,
        );
  const coverage = accounts.map((a) => ({ name: a.name, ...accountCoverage(db, a.id) }));
  const leftOut =
    scope.accountId !== undefined
      ? []
      : coverage
          .filter(
            (c) =>
              c.from !== null && c.through !== null && months.some((m) => c.through! < `${m}-01`),
          )
          .map((c) => ({ name: c.name, through: c.through! }));
  return { months: new Set(months.filter((m) => isMonthComplete(m, coverage))), leftOut };
}
