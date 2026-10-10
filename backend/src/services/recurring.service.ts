import { eq, sql } from "drizzle-orm";
import { recurringDismissed } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { merchantKey } from "../utils/merchant.js";
import { AppError } from "../utils/errors.js";
import { NOT_TRANSFER } from "./analytics.service.js";
import { getSettings } from "./settings.service.js";
import { countedAccount } from "./account-scope.js";

/**
 * Finds charges and deposits that repeat on a schedule (subscriptions, rent, bills, paychecks),
 * from the transactions already stored. Nothing is guessed from outside the data: a series needs
 * at least three occurrences (two for a yearly one) at steady intervals, and the page says how
 * many it found. Transfers and card payments are left out, as everywhere else.
 */

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";
export type Direction = "out" | "in";

interface CadenceRule {
  cadence: Cadence;
  days: number;
  /** An interval within this many days of `days` counts as on schedule. */
  tolerance: number;
  /** How many payments make up a month, for the "per month" figure. */
  perMonth: number;
  minOccurrences: number;
}

const RULES: CadenceRule[] = [
  { cadence: "weekly", days: 7, tolerance: 1, perMonth: 52 / 12, minOccurrences: 4 },
  { cadence: "biweekly", days: 14, tolerance: 2, perMonth: 26 / 12, minOccurrences: 4 },
  { cadence: "monthly", days: 30.4, tolerance: 4, perMonth: 1, minOccurrences: 3 },
  { cadence: "quarterly", days: 91, tolerance: 7, perMonth: 1 / 3, minOccurrences: 3 },
  { cadence: "yearly", days: 365, tolerance: 10, perMonth: 1 / 12, minOccurrences: 2 },
];

export const LOOKBACK_DAYS = 760;
/** Amounts within this share of the typical amount count as "the same amount". */
const AMOUNT_TOLERANCE = 0.15;
const PRICE_CHANGE_THRESHOLD = 0.03;

export interface Occurrence {
  date: string;
  /** Always positive: the size of the payment, whichever direction it went. */
  amountMinor: number;
}

export interface Classification {
  cadence: Cadence;
  perMonth: number;
  /** Share of gaps that were one normal step (the rest were skipped periods). */
  regularity: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const dayMs = (day: string): number => Date.parse(`${day}T12:00:00Z`);
const gapDays = (a: string, b: string): number => Math.round((dayMs(b) - dayMs(a)) / 86_400_000);

/**
 * Decides whether dated payments follow a schedule. Same-day payments must already be combined.
 * Skipped periods (a gap of two or three steps) are tolerated, but most gaps must be one step.
 */
export function classifySchedule(dates: string[]): Classification | null {
  const sorted = [...dates].sort();
  if (sorted.length < 2) return null;
  const gaps = sorted.slice(1).map((d, i) => gapDays(sorted[i]!, d));
  let best: Classification | null = null;
  let bestScore = 0;
  for (const rule of RULES) {
    if (sorted.length < rule.minOccurrences) continue;
    const near = (gap: number, steps: number): boolean =>
      Math.abs(gap - rule.days * steps) <= rule.tolerance * steps;
    const one = gaps.filter((g) => near(g, 1)).length;
    const skipped = gaps.filter((g) => !near(g, 1) && (near(g, 2) || near(g, 3))).length;
    const regularity = one / gaps.length;
    if (regularity < 0.6 || (one + skipped) / gaps.length < 0.8) continue;
    const score = regularity + (one + skipped) / gaps.length;
    if (score > bestScore) {
      bestScore = score;
      best = { cadence: rule.cadence, perMonth: rule.perMonth, regularity };
    }
  }
  return best;
}

/** `day` moved forward by whole months, keeping the day of the month where the month is long enough. */
export function addMonthsToDay(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function nextAfter(lastDate: string, cadence: Cadence): string {
  switch (cadence) {
    case "weekly":
      return addDays(lastDate, 7);
    case "biweekly":
      return addDays(lastDate, 14);
    case "monthly":
      return addMonthsToDay(lastDate, 1);
    case "quarterly":
      return addMonthsToDay(lastDate, 3);
    case "yearly":
      return addMonthsToDay(lastDate, 12);
  }
}

export interface RecurringSeries {
  /** Stable across runs, so a series can be marked "not recurring". */
  key: string;
  merchant: string;
  direction: Direction;
  cadence: Cadence;
  /** The usual amount (the median), always positive. */
  typicalAmountMinor: number;
  lastAmountMinor: number;
  /** The usual amount does not hold: bills such as utilities. */
  amountVaries: boolean;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextExpected: string;
  /** `active` while the next one is not long overdue; `lapsed` when it seems to have stopped. */
  status: "active" | "lapsed";
  perMonthMinor: number;
  accountNames: string[];
  priceChange: { fromMinor: number; toMinor: number; date: string } | null;
  dismissed: boolean;
}

export interface RecurringReport {
  currency: string;
  asOf: string;
  series: RecurringSeries[];
  /** Active series only, converted to a monthly figure. */
  monthlyOutMinor: number;
  monthlyInMinor: number;
  /** Active series expected in the next 30 days (or just past due), soonest first. */
  upcoming: Array<{
    key: string;
    merchant: string;
    direction: Direction;
    date: string;
    amountMinor: number;
    overdue: boolean;
  }>;
  /** How many transactions were looked at, and over how many days. */
  basis: { transactions: number; days: number };
}

interface Row {
  date: string;
  /** The bank's own description: stable for a payee, unlike the cleaned merchant name, which a bank may add later. */
  key_name: string;
  /** The merchant as shown in the app (the user's edit, else the bank's cleaned name), when there is one. */
  merchant: string | null;
  amount_minor: number;
  account: string;
}

export function buildSeries(rows: Row[], today: string, dismissed: Set<string>): RecurringSeries[] {
  const groups = new Map<string, { direction: Direction; items: Row[] }>();
  for (const row of rows) {
    const norm = merchantKey(row.key_name);
    if (!norm) continue;
    const direction: Direction = row.amount_minor < 0 ? "in" : "out";
    const key = `${direction}:${norm}`;
    const group = groups.get(key) ?? { direction, items: [] };
    group.items.push(row);
    groups.set(key, group);
  }

  const result: RecurringSeries[] = [];
  for (const [key, group] of groups) {
    // Payments made on the same day are one payment.
    const byDay = new Map<string, number>();
    for (const r of group.items) {
      byDay.set(r.date, (byDay.get(r.date) ?? 0) + Math.abs(r.amount_minor));
    }
    const occurrences: Occurrence[] = [...byDay.entries()]
      .map(([date, amountMinor]) => ({ date, amountMinor }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const schedule = classifySchedule(occurrences.map((o) => o.date));
    if (!schedule) continue;

    const amounts = occurrences.map((o) => o.amountMinor);
    const typical = Math.round(median(amounts));
    const steady =
      amounts.filter((a) => Math.abs(a - typical) <= typical * AMOUNT_TOLERANCE).length /
      amounts.length;
    const frequent = schedule.cadence === "weekly" || schedule.cadence === "biweekly";
    // Frequent habits (groceries, coffee) vary in amount; only fixed amounts are subscriptions.
    if (frequent && steady < 0.6) continue;
    const last = occurrences.at(-1)!;
    const next = nextAfter(last.date, schedule.cadence);
    const stepDays = gapDays(last.date, next);
    const lapsed = gapDays(next, today) > Math.max(7, stepDays * 0.5);

    let priceChange: RecurringSeries["priceChange"] = null;
    if (occurrences.length >= 3 && steady >= 0.8) {
      const before = occurrences.slice(0, -1).map((o) => o.amountMinor);
      const prev = median(before);
      const stable = before.every((a) => Math.abs(a - prev) <= prev * PRICE_CHANGE_THRESHOLD);
      if (stable && prev > 0 && Math.abs(last.amountMinor - prev) / prev > PRICE_CHANGE_THRESHOLD) {
        priceChange = { fromMinor: Math.round(prev), toMinor: last.amountMinor, date: last.date };
      }
    }

    const accounts = new Set(group.items.map((r) => r.account));
    // Shown under the newest cleaned merchant name there is, else the bank's description.
    const named = [...group.items]
      .filter((r) => r.merchant)
      .sort((a, b) => b.date.localeCompare(a.date));
    result.push({
      key,
      merchant: named[0]?.merchant ?? group.items[0]!.key_name,
      direction: group.direction,
      cadence: schedule.cadence,
      typicalAmountMinor: typical,
      lastAmountMinor: last.amountMinor,
      amountVaries: steady < 0.8,
      occurrences: occurrences.length,
      firstDate: occurrences[0]!.date,
      lastDate: last.date,
      nextExpected: next,
      status: lapsed ? "lapsed" : "active",
      perMonthMinor: Math.round(typical * schedule.perMonth),
      accountNames: [...accounts].sort(),
      priceChange,
      dismissed: dismissed.has(key),
    });
  }
  return result.sort(
    (a, b) =>
      Number(a.status === "lapsed") - Number(b.status === "lapsed") ||
      b.perMonthMinor - a.perMonthMinor ||
      a.key.localeCompare(b.key),
  );
}

export function recurringReport(
  db: AppDb,
  options: { today?: string | undefined; includeDismissed?: boolean | undefined } = {},
): RecurringReport {
  const settings = getSettings(db);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const since = addDays(today, -LOOKBACK_DAYS);
  const rows = db.all<Row>(sql`
    SELECT t.date AS date,
           t.name AS key_name,
           coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name) AS merchant,
           t.amount_minor AS amount_minor,
           a.name AS account
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN plaid_items p ON p.id = a.plaid_item_id
    WHERE (p.environment = ${settings.plaidEnvironment} OR a.plaid_item_id IS NULL)
      AND ${countedAccount()}
      AND t.currency = ${settings.currency}
      AND t.date >= ${since} AND t.date <= ${today}
      AND ${NOT_TRANSFER}
  `);

  const hidden = new Set(
    db
      .select({ key: recurringDismissed.key })
      .from(recurringDismissed)
      .all()
      .map((r) => r.key),
  );
  const all = buildSeries(rows, today, hidden);
  const series = options.includeDismissed ? all : all.filter((s) => !s.dismissed);

  const live = series.filter((s) => s.status === "active" && !s.dismissed);
  const horizon = addDays(today, 30);
  const floor = addDays(today, -7);
  return {
    currency: settings.currency,
    asOf: today,
    series,
    monthlyOutMinor: live
      .filter((s) => s.direction === "out")
      .reduce((n, s) => n + s.perMonthMinor, 0),
    monthlyInMinor: live
      .filter((s) => s.direction === "in")
      .reduce((n, s) => n + s.perMonthMinor, 0),
    upcoming: live
      .filter((s) => s.nextExpected <= horizon && s.nextExpected >= floor)
      .map((s) => ({
        key: s.key,
        merchant: s.merchant,
        direction: s.direction,
        date: s.nextExpected,
        amountMinor: s.typicalAmountMinor,
        overdue: s.nextExpected < today,
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key)),
    basis: { transactions: rows.length, days: LOOKBACK_DAYS },
  };
}

const KEY_PATTERN = /^(in|out):.{1,200}$/;

export function dismissSeries(db: AppDb, key: string, merchant: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new AppError(400, "invalid_key", "That is not a recurring item.");
  }
  db.insert(recurringDismissed)
    .values({ key, merchant: merchant.slice(0, 200), createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
}

export function restoreSeries(db: AppDb, key: string): void {
  db.delete(recurringDismissed).where(eq(recurringDismissed.key, key)).run();
}

export { merchantKey };
