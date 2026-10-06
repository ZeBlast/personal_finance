/**
 * Date ranges for widgets. Everything is a plain `YYYY-MM-DD` string in the user's own calendar
 * (not UTC), matching how the backend stores bank dates.
 */

export interface DateRange {
  from: string;
  to: string;
}

export const PERIOD_OPTIONS = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "last-30-days", label: "Last 30 days" },
  { value: "last-90-days", label: "Last 90 days" },
  { value: "this-year", label: "This year" },
  { value: "last-12-months", label: "Last 12 months" },
] as const;

export type PeriodId = (typeof PERIOD_OPTIONS)[number]["value"];

const pad = (n: number): string => String(n).padStart(2, "0");

/** A local date as YYYY-MM-DD. */
export function toDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today's local date, replaceable in tests. */
export function today(now: Date = new Date()): string {
  return toDay(now);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** `YYYY-MM` of a date. */
export const monthOf = (day: string): string => day.slice(0, 7);

/** The month `delta` months from `month` (`YYYY-MM`). */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const total = year * 12 + (mon - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

export const firstOfMonth = (month: string): string => `${month}-01`;

export function lastOfMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return `${month}-${pad(daysInMonth(year, mon - 1))}`;
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return toDay(new Date(y, m - 1, d + delta));
}

export interface ResolvedPeriod extends DateRange {
  label: string;
  /** The comparable range just before it, for "compared to last time". */
  previous: DateRange;
  previousLabel: string;
}

/**
 * Turns a preset into dates, plus the range to compare it with. "This month" is compared with the
 * same number of days of last month, so a half-finished month is not set against a whole one.
 */
export function resolvePeriod(preset: string, now: Date = new Date()): ResolvedPeriod {
  const todayDay = toDay(now);
  const month = monthOf(todayDay);

  switch (preset) {
    case "last-month": {
      const last = shiftMonth(month, -1);
      const before = shiftMonth(month, -2);
      return {
        from: firstOfMonth(last),
        to: lastOfMonth(last),
        label: "last month",
        previous: { from: firstOfMonth(before), to: lastOfMonth(before) },
        previousLabel: "the month before",
      };
    }
    case "last-30-days":
    case "last-90-days": {
      const days = preset === "last-30-days" ? 30 : 90;
      const from = addDays(todayDay, -(days - 1));
      return {
        from,
        to: todayDay,
        label: `the last ${days} days`,
        previous: { from: addDays(from, -days), to: addDays(from, -1) },
        previousLabel: `the ${days} days before`,
      };
    }
    case "this-year": {
      const year = now.getFullYear();
      const prevEnd = `${year - 1}-${pad(now.getMonth() + 1)}-${pad(
        Math.min(now.getDate(), daysInMonth(year - 1, now.getMonth())),
      )}`;
      return {
        from: `${year}-01-01`,
        to: todayDay,
        label: "this year",
        previous: { from: `${year - 1}-01-01`, to: prevEnd },
        previousLabel: "the same point last year",
      };
    }
    case "last-12-months": {
      const from = `${shiftMonth(month, -11)}-01`;
      return {
        from,
        to: todayDay,
        label: "the last 12 months",
        previous: { from: `${shiftMonth(month, -23)}-01`, to: addDays(from, -1) },
        previousLabel: "the 12 months before",
      };
    }
    default: {
      // this-month
      const prev = shiftMonth(month, -1);
      const sameDay = Math.min(now.getDate(), Number(lastOfMonth(prev).slice(8)));
      return {
        from: firstOfMonth(month),
        to: todayDay,
        label: "this month",
        previous: { from: firstOfMonth(prev), to: `${prev}-${pad(sameDay)}` },
        previousLabel: "the same days last month",
      };
    }
  }
}

/** The last `count` months up to and including this one: from the 1st of the first, to today. */
export function recentMonths(count: number, now: Date = new Date()): DateRange {
  const todayDay = toDay(now);
  return { from: firstOfMonth(shiftMonth(monthOf(todayDay), -(count - 1))), to: todayDay };
}

/** "Sep 2026" for `2026-09`. */
export function monthLabel(month: string, style: "short" | "long" = "short"): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return new Date(year, mon - 1, 1).toLocaleDateString(undefined, {
    month: style === "long" ? "long" : "short",
    year: "numeric",
  });
}

/** "Sep" for `2026-09` (for chart axes). */
export function monthShort(month: string): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return new Date(year, mon - 1, 1).toLocaleDateString(undefined, { month: "short" });
}
