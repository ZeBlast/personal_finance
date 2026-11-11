import type { ForecastDay, ForecastEvent } from "../types/planning";

/**
 * The Cash forecast page's arithmetic over the days the backend sends: what comes in and goes out,
 * week by week, by kind, and the biggest payments ahead. All pure.
 */

export type Source = ForecastEvent["source"];

const DAY_MS = 86_400_000;
const dayMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface ForecastTotals {
  /** Everything expected to arrive (positive). */
  inMinor: number;
  /** Everything expected to leave (positive), the held-back spending caps included. */
  outMinor: number;
  /** In less out: how much the balance moves over the window. */
  netMinor: number;
  /** The first day the balance is below zero, or null when it never is. */
  firstBelowZero: string | null;
  /** How many days from today until then. */
  daysUntilBelowZero: number | null;
}

/** What comes in and goes out over the whole forecast. */
export function forecastTotals(days: ForecastDay[], today: string): ForecastTotals {
  let inMinor = 0;
  let outMinor = 0;
  for (const d of days) {
    for (const e of d.events) {
      if (e.amountMinor > 0) inMinor += e.amountMinor;
      else outMinor -= e.amountMinor;
    }
  }
  const below = days.find((d) => d.balanceMinor < 0)?.date ?? null;
  return {
    inMinor,
    outMinor,
    netMinor: inMinor - outMinor,
    firstBelowZero: below,
    daysUntilBelowZero: below === null ? null : Math.round((dayMs(below) - dayMs(today)) / DAY_MS),
  };
}

export interface ForecastWeek {
  /** The first and last forecast day in this week (weeks run Monday to Sunday). */
  start: string;
  end: string;
  inMinor: number;
  outMinor: number;
  /** The balance at the end of the week's last day, and the lowest it reaches in the week. */
  endBalanceMinor: number;
  lowestMinor: number;
  /** How many things happen in it (the daily cap hold-back aside). */
  events: number;
}

/** Monday of the week a day is in. */
function mondayOf(date: string): string {
  const ms = dayMs(date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return isoDay(ms - weekday * DAY_MS);
}

/** The forecast a week at a time, oldest first; the first and last weeks may be part weeks. */
export function weeklyBreakdown(days: ForecastDay[]): ForecastWeek[] {
  const weeks = new Map<string, ForecastWeek>();
  for (const d of days) {
    const key = mondayOf(d.date);
    const w = weeks.get(key) ?? {
      start: d.date,
      end: d.date,
      inMinor: 0,
      outMinor: 0,
      endBalanceMinor: d.balanceMinor,
      lowestMinor: d.balanceMinor,
      events: 0,
    };
    weeks.set(key, w);
    w.end = d.date;
    w.endBalanceMinor = d.balanceMinor;
    w.lowestMinor = Math.min(w.lowestMinor, d.balanceMinor);
    for (const e of d.events) {
      if (e.amountMinor > 0) w.inMinor += e.amountMinor;
      else w.outMinor -= e.amountMinor;
      if (e.source !== "cap_holdback") w.events += 1;
    }
  }
  return [...weeks.values()];
}

export interface SourceTotal {
  source: Source;
  inMinor: number;
  outMinor: number;
  count: number;
}

/** Money in and out by kind (recurring, card bills, ...), the most money moved first. */
export function bySource(days: ForecastDay[]): SourceTotal[] {
  const totals = new Map<Source, SourceTotal>();
  for (const d of days) {
    for (const e of d.events) {
      const t = totals.get(e.source) ?? { source: e.source, inMinor: 0, outMinor: 0, count: 0 };
      totals.set(e.source, t);
      if (e.amountMinor > 0) t.inMinor += e.amountMinor;
      else t.outMinor -= e.amountMinor;
      t.count += 1;
    }
  }
  return [...totals.values()].sort((a, b) => b.inMinor + b.outMinor - (a.inMinor + a.outMinor));
}

export interface DatedEvent extends ForecastEvent {
  date: string;
}

/** The largest payments going out, biggest first (the daily cap hold-back is not a payment). */
export function biggestOut(days: ForecastDay[], count = 5): DatedEvent[] {
  return days
    .flatMap((d) => d.events.map((e) => ({ ...e, date: d.date })))
    .filter((e) => e.amountMinor < 0 && e.source !== "cap_holdback")
    .sort((a, b) => a.amountMinor - b.amountMinor || (a.date < b.date ? -1 : 1))
    .slice(0, count);
}

export interface EventFilter {
  /** "in", "out", or both. */
  direction: "all" | "in" | "out";
  /** One kind, or every kind. */
  source: Source | "all";
  /** Words the label has to hold (any case). */
  text: string;
  /** Only these days (a week picked from the week-by-week list), ends included. */
  range?: { start: string; end: string } | null;
}

export const NO_FILTER: EventFilter = { direction: "all", source: "all", text: "" };

/**
 * The days something happens on, with only the events the filter lets through (never the daily cap
 * hold-back, which has its own summary row). Each day keeps its real closing balance.
 */
export function filterEvents(days: ForecastDay[], filter: EventFilter): ForecastDay[] {
  const words = filter.text.trim().toLowerCase();
  const range = filter.range ?? null;
  return days
    .filter((d) => range === null || (d.date >= range.start && d.date <= range.end))
    .map((d) => ({
      ...d,
      events: d.events.filter(
        (e) =>
          e.source !== "cap_holdback" &&
          (filter.direction === "all" || (filter.direction === "in") === e.amountMinor > 0) &&
          (filter.source === "all" || e.source === filter.source) &&
          (words === "" || e.label.toLowerCase().includes(words)),
      ),
    }))
    .filter((d) => d.events.length > 0);
}
