/**
 * Calendar-date helpers. Dates are plain `YYYY-MM-DD` strings with no time zone, exactly as banks
 * report them, so arithmetic is done in UTC to stay free of daylight-saving surprises.
 */

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** A real calendar date written as YYYY-MM-DD (so "2026-02-31" is rejected). */
export function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A month written as YYYY-MM with a month from 01 to 12. */
export function isRealMonth(value: string): boolean {
  return MONTH.test(value) && isRealDate(`${value}-01`);
}

const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const fromDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export function addDays(day: string, days: number): string {
  return toDay(fromDay(day) + days * DAY_MS);
}

/** The Monday of the week containing `day`. */
export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

export function lastOfMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return toDay(Date.UTC(year, mon, 0)); // day 0 of the next month is the last day of this one
}

/** `YYYY-MM` of a date. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function addMonths(month: string, months: number): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const total = year * 12 + (mon - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Every day from `from` to `to`, inclusive. */
export function listDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** The Monday of every week that touches `from`..`to`. */
export function listWeeks(from: string, to: string): string[] {
  const weeks: string[] = [];
  for (let d = mondayOf(from); d <= to; d = addDays(d, 7)) weeks.push(d);
  return weeks;
}

/** Every month that touches `from`..`to`, as YYYY-MM. */
export function listMonths(from: string, to: string): string[] {
  const months: string[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) months.push(m);
  return months;
}
