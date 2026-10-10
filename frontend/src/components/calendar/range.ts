import { toDay } from "../../lib/period";
import { formatDay } from "../../lib/time";

/** Pure helpers for choosing months, years, and spans of days on the calendar. */

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface DaySpan {
  from: string;
  to: string;
}

/** Two days in either order, as a span from the earlier to the later. */
export function orderSpan(a: string, b: string): DaySpan {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

export function inSpan(day: string, span: DaySpan | null): boolean {
  return span !== null && day >= span.from && day <= span.to;
}

export function isSingleDay(span: DaySpan): boolean {
  return span.from === span.to;
}

/** The days in a span, counting both ends. */
export function spanLength(span: DaySpan): number {
  const [y1, m1, d1] = span.from.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = span.to.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

/** The title for a selection: "Oct 6, 2026" or "Oct 3, 2026 to Oct 9, 2026 (7 days)". */
export function spanTitle(span: DaySpan): string {
  if (isSingleDay(span)) return formatDay(span.from);
  return `${formatDay(span.from)} to ${formatDay(span.to)} (${spanLength(span)} days)`;
}

/** The year and the month number (0 to 11) of a `YYYY-MM` string. */
export function splitMonth(month: string): { year: number; monthIndex: number } {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return { year, monthIndex: mon - 1 };
}

export function joinMonth(year: number, monthIndex: number): string {
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}`;
}

/** The years offered in the year picker: a window around this year, plus the one being shown. */
export function yearChoices(shownYear: number, thisYear: number): number[] {
  const first = Math.min(thisYear - 15, shownYear);
  const last = Math.max(thisYear + 10, shownYear);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** The day `delta` days from `day`. */
export function stepDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return toDay(new Date(y, m - 1, d + delta));
}

/** Sunday is 0. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getDay();
}

/** One cell of the month grid: days from the month before and after fill the first and last weeks. */
export interface GridCell {
  date: string;
  inMonth: boolean;
}

/** Whole weeks (Sunday first) covering a month, with the neighbouring months' days in the gaps. */
export function fullMonthGrid(month: string): GridCell[][] {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(year, mon - 1, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const cells = first.getUTCDay() + daysInMonth;
  const count = Math.ceil(cells / 7) * 7;
  const weeks: GridCell[][] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push({ date, inMonth: date.slice(0, 7) === month });
  }
  return weeks;
}
