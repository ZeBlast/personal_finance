import type { AppDb } from "../db/client.js";
import { addDays, addMonths, firstOfMonth, lastOfMonth, listMonths } from "../utils/dates.js";
import { summarize } from "./analytics.service.js";
import { cancelledSeries } from "./forecast.service.js";
import {
  addMonthsToDay,
  recurringReport,
  type Cadence,
  type RecurringSeries,
} from "./recurring.service.js";

/** Shared by the month plan and the year ahead: when recurring money is expected, by month. */

const STEP: Record<Cadence, { days: number } | { months: number }> = {
  weekly: { days: 7 },
  biweekly: { days: 14 },
  semimonthly: { days: 15 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  yearly: { months: 12 },
};

/**
 * A series' dates from `from` to `to` (inclusive), on its schedule through `lastDate`: whole
 * steps back and forth from that day, so a month's day never drifts. Pure.
 */
export function seriesDatesIn(
  lastDate: string,
  cadence: Cadence,
  from: string,
  to: string,
): string[] {
  if (cadence === "semimonthly") return twiceMonthly(lastDate, from, to);
  const step = STEP[cadence];
  const at = (k: number): string =>
    "days" in step ? addDays(lastDate, k * step.days) : addMonthsToDay(lastDate, k * step.months);
  const out: string[] = [];
  for (let k = 0, guard = 0; guard < 2000; k -= 1, guard += 1) {
    const d = at(k);
    if (d < from) break;
    if (d <= to) out.push(d);
  }
  for (let k = 1, guard = 0; guard < 2000; k += 1, guard += 1) {
    const d = at(k);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out.sort();
}

/**
 * Pay twice a month: on the last date's day and the day half a month from it (the 1st and 16th,
 * the 15th and 30th), each kept within shorter months. Pure.
 */
function twiceMonthly(lastDate: string, from: string, to: string): string[] {
  const day = Number(lastDate.slice(8, 10));
  const days = [day, day <= 15 ? day + 15 : day - 15];
  const out: string[] = [];
  for (const month of listMonths(from.slice(0, 7), to.slice(0, 7))) {
    const last = Number(lastOfMonth(month).slice(8, 10));
    for (const d of days) {
      const date = `${month}-${String(Math.min(d, last)).padStart(2, "0")}`;
      if (date >= from && date <= to && !out.includes(date)) out.push(date);
    }
  }
  return out.sort();
}

export type PlanSeries = RecurringSeries & {
  /** The day its charges stop, when the user said it is cancelled. */
  stopOn: string | null;
};

const norm = (s: string): string => s.trim().toLowerCase();

/** Whether two merchant names are the same payee (any case, stray spaces). Pure. */
export function sameMerchant(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** The recurring series that count in a plan: active and not dismissed, with any stop day. */
export function activeSeries(db: AppDb, today: string): PlanSeries[] {
  const stops = cancelledSeries(db);
  return recurringReport(db, { today })
    .series.filter((s) => s.status === "active" && !s.dismissed)
    .map((s) => ({ ...s, stopOn: stops.get(s.key) ?? null }));
}

/** A plan series' dates in a span, leaving out those on or after its stop. Pure. */
export function planDatesIn(s: PlanSeries, from: string, to: string): string[] {
  return seriesDatesIn(s.lastDate, s.cadence, from, to).filter(
    (d) => s.stopOn === null || d < s.stopOn,
  );
}

const USUAL_MONTHS = 3;

/**
 * A usual month of spending per category (its own transactions, not its subcategories'; 0 is
 * uncategorized): the average of the three complete months before `baseMonth`, over the months
 * that had any spending. Refunds can leave a category below zero; it then counts as 0.
 */
export function usualByLeaf(
  db: AppDb,
  environment: string,
  baseMonth: string,
): Map<number, number> {
  const totals = new Map<number, number>();
  let months = 0;
  for (let k = 1; k <= USUAL_MONTHS; k += 1) {
    const month = addMonths(baseMonth, -k);
    const s = summarize(db, {
      from: firstOfMonth(month),
      to: lastOfMonth(month),
      groupBy: "category",
      includeTransfers: false,
      includePending: false,
      fill: false,
      environment,
    });
    if (s.totals.spendingMinor > 0) months += 1;
    for (const r of s.rows) {
      const id = Number(r.key);
      totals.set(id, (totals.get(id) ?? 0) + r.spendingMinor);
    }
  }
  const out = new Map<number, number>();
  for (const [id, total] of totals)
    out.set(id, Math.max(0, Math.round(total / Math.max(1, months))));
  return out;
}

/**
 * Usual spending with no cap, by top-level category: each uncapped category's usual month, less
 * what the plan already counts as bills there (`billsByTop`, a month's worth). Pure.
 */
export function usualLines(
  byLeaf: Map<number, number>,
  parentOf: Map<number, number | null>,
  nameOf: Map<number, string>,
  isCapped: (categoryId: number | null) => boolean,
  billsByTop: Map<number, number>,
): Array<{ topId: number; label: string; amountMinor: number }> {
  const byTop = new Map<number, number>();
  for (const [leaf, amount] of byLeaf) {
    if (leaf !== 0 && isCapped(leaf)) continue;
    const top = leaf === 0 ? 0 : (parentOf.get(leaf) ?? leaf);
    byTop.set(top, (byTop.get(top) ?? 0) + amount);
  }
  const out: Array<{ topId: number; label: string; amountMinor: number }> = [];
  for (const [top, amount] of byTop) {
    const left = amount - (billsByTop.get(top) ?? 0);
    if (left <= 0) continue;
    out.push({
      topId: top,
      label: top === 0 ? "Uncategorized" : (nameOf.get(top) ?? "Other"),
      amountMinor: left,
    });
  }
  return out.sort((a, b) => b.amountMinor - a.amountMinor);
}

/** The top-level category a bill belongs to (0 for none). Pure. */
export function topOf(categoryId: number | null, parentOf: Map<number, number | null>): number {
  if (categoryId === null) return 0;
  return parentOf.get(categoryId) ?? categoryId;
}
