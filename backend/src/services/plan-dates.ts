import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { listPlanned } from "./calendar.service.js";
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

export type PlanSeries = RecurringSeries & {
  /** The day its charges stop, when the user said it is cancelled. */
  stopOn: string | null;
};

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * The recurring series that count in a plan: active, not dismissed, and not also an expected
 * transaction the user entered by hand (that one counts instead, as in the cash forecast).
 */
export function activeSeries(db: AppDb, today: string): PlanSeries[] {
  const stops = cancelledSeries(db);
  const planned = new Set(listPlanned(db).map((p) => norm(p.merchant)));
  return recurringReport(db, { today })
    .series.filter((s) => s.status === "active" && !s.dismissed && !planned.has(norm(s.merchant)))
    .map((s) => ({ ...s, stopOn: stops.get(s.key) ?? null }));
}

/** A plan series' dates in a span, leaving out those on or after its stop. Pure. */
export function planDatesIn(s: PlanSeries, from: string, to: string): string[] {
  return seriesDatesIn(s.lastDate, s.cadence, from, to).filter(
    (d) => s.stopOn === null || d < s.stopOn,
  );
}
