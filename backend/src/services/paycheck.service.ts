import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { countedAccount } from "./account-scope.js";
import { IS_INCOME, NOT_TRANSFER } from "./analytics.service.js";
import { classifySchedule, nextAfter, type Cadence } from "./recurring.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Regular pay, found in the income: money in from one source that arrives on a schedule (every week,
 * every two weeks, twice a month, or monthly) for about the same amount. Each is described once,
 * with the usual amount, when the next one should come, and what it adds up to for the year, so the
 * Taxes page and planning can use real pay rather than a rough guess.
 */

export interface Paycheck {
  /** The same key the Taxes page uses for an income source: `income:<source in lower case>`. */
  key: string;
  source: string;
  cadence: Cadence;
  /** The usual amount (the median of recent paychecks), in cents. */
  typicalMinor: number;
  lastDate: string;
  lastAmountMinor: number;
  nextExpected: string;
  occurrences: number;
  accountName: string;
  /** Paid so far in the year asked about. */
  receivedThisYearMinor: number;
  /** Paydays still to come in that year, from the schedule. */
  paydaysLeft: number;
  /** Received so far, plus the paydays left at the usual amount. */
  projectedYearMinor: number;
  /** Still arriving on schedule (the last one is not long overdue). */
  active: boolean;
}

/** Schedules pay comes on (a quarterly or yearly payment is a bonus or interest, not pay). */
const PAY_CADENCES: Cadence[] = ["weekly", "biweekly", "semimonthly", "monthly"];
const LOOKBACK_DAYS = 400;
/** A paycheck within this share of the usual amount counts as "the same pay". */
const STEADY = 0.25;

interface Row {
  date: string;
  source: string;
  amount: number;
  account: string;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Finds regular pay from rows of income (already filtered to money in that counts as income). */
export function findPaychecks(rows: Row[], today: string, year: number): Paycheck[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `income:${r.source.trim().toLowerCase()}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const out: Paycheck[] = [];
  for (const [key, list] of groups) {
    // Two deposits on one day (a split direct deposit) are one paycheck.
    const byDay = new Map<string, number>();
    for (const r of list) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount);
    const days = [...byDay.keys()].sort();
    const schedule = classifySchedule(days);
    if (!schedule || !PAY_CADENCES.includes(schedule.cadence)) continue;
    const amounts = days.map((d) => byDay.get(d)!);
    const recent = amounts.slice(-6);
    const typical = Math.round(median(recent));
    const steady =
      recent.filter((a) => Math.abs(a - typical) <= typical * STEADY).length / recent.length;
    if (typical <= 0 || steady < 0.6) continue;

    const lastDate = days.at(-1)!;
    let next = nextAfter(lastDate, schedule.cadence);
    // Overdue paydays (the bank has not shown them yet) still count as coming.
    const active = next >= addDays(today, -10);
    // Paydays left in the year: every one after the last paycheck (one a few days late included).
    let paydaysLeft = 0;
    if (active) {
      for (let guard = 0; next <= yearEnd && guard < 60; guard++) {
        if (next >= yearStart) paydaysLeft += 1;
        next = nextAfter(next, schedule.cadence);
      }
    }
    const received = days
      .filter((d) => d >= yearStart && d <= yearEnd)
      .reduce((sum, d) => sum + byDay.get(d)!, 0);
    const named = [...list].sort((a, b) => b.date.localeCompare(a.date))[0]!;
    out.push({
      key,
      source: named.source,
      cadence: schedule.cadence,
      typicalMinor: typical,
      lastDate,
      lastAmountMinor: byDay.get(lastDate)!,
      nextExpected: nextAfter(lastDate, schedule.cadence),
      occurrences: days.length,
      accountName: named.account,
      receivedThisYearMinor: received,
      paydaysLeft,
      projectedYearMinor: received + paydaysLeft * typical,
      active,
    });
  }
  return out.sort((a, b) => b.projectedYearMinor - a.projectedYearMinor);
}

export function detectPaychecks(
  db: AppDb,
  options: { year?: number | undefined; today?: string | undefined } = {},
): Paycheck[] {
  const settings = getSettings(db);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const year = options.year ?? Number(today.slice(0, 4));
  // Up to the end of that year, so a past year's paychecks are all there.
  const until = `${year}-12-31` < today ? `${year}-12-31` : today;
  const since = addDays(until, -LOOKBACK_DAYS);
  const rows = db.all<Row>(sql`
    select coalesce(t.authorized_date, t.date) as date,
      coalesce(nullif(trim(t.sender_user), ''), nullif(trim(t.sender), ''),
        nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as source,
      -t.amount_minor as amount, a.name as account
    from transactions t
      join accounts a on a.id = t.account_id
      left join plaid_items p on p.id = a.plaid_item_id
      left join categories c on c.id = t.category_id
    where (p.environment = ${settings.plaidEnvironment} or a.plaid_item_id is null)
      and ${countedAccount()} and t.amount_minor < 0 and t.pending = 0
      and coalesce(t.authorized_date, t.date) between ${since} and ${until}
      and ${NOT_TRANSFER} and ${IS_INCOME}
      -- Interest and dividends come on a schedule too, but they are not pay.
      and coalesce(t.plaid_category_detailed, '') not in ('INCOME_INTEREST_EARNED', 'INCOME_DIVIDENDS')
      and lower(coalesce(c.name, '')) <> 'interest & dividends'`);
  return findPaychecks(rows, until === today ? today : until, year);
}
