import { addDays, addMonths, isRealDate, lastOfMonth } from "./dates.js";

/**
 * Repeat rules for expected transactions, expanded into plain `YYYY-MM-DD` dates. Everything is
 * calendar arithmetic in UTC, so daylight saving never moves an occurrence.
 */

export const FREQUENCIES = ["once", "daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface RepeatRule {
  startDate: string;
  frequency: Frequency;
  /** Every N days, weeks, months, or years. */
  repeatEvery: number;
  /** Weekly: the days of the week (0 = Sunday). Monthly by weekday: the one weekday. */
  weekdays: number[];
  /** Monthly: the same date each month (`day`) or such as the 2nd Tuesday (`weekday`). */
  monthMode: "day" | "weekday" | null;
  /** Monthly by day: 1 to 31, or -1 for the last day. Empty means the start date's day. */
  dayOfMonth: number | null;
  /** Monthly by weekday: 1 to 4, or -1 for the last. */
  nthWeek: number | null;
  endDate: string | null;
  /** Stop after this many occurrences. */
  maxCount: number | null;
}

/** A hard stop so a bad rule can never loop for long. */
const MAX_STEPS = 20_000;

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/** The date in `month` for a day-of-month, using the month's last day when it has fewer days. */
function dayInMonth(month: string, dayOfMonth: number): string {
  const last = Number(lastOfMonth(month).slice(8));
  const day = dayOfMonth === -1 ? last : Math.min(dayOfMonth, last);
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** The nth (1 to 4) or last (-1) given weekday of a month. */
function nthWeekdayInMonth(month: string, weekday: number, nth: number): string {
  if (nth === -1) {
    let day = lastOfMonth(month);
    while (weekdayOf(day) !== weekday) day = addDays(day, -1);
    return day;
  }
  let day = `${month}-01`;
  while (weekdayOf(day) !== weekday) day = addDays(day, 1);
  return addDays(day, 7 * (nth - 1));
}

/** Every date the rule produces, in order, starting at its first occurrence. */
function* generate(rule: RepeatRule): Generator<string> {
  const start = rule.startDate;
  const every = Math.max(1, rule.repeatEvery);

  if (rule.frequency === "once") {
    yield start;
    return;
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    if (rule.frequency === "daily") {
      yield addDays(start, step * every);
    } else if (rule.frequency === "weekly") {
      const days = rule.weekdays.length > 0 ? [...rule.weekdays] : [weekdayOf(start)];
      days.sort((a, b) => a - b);
      // Weeks run Sunday to Saturday, counted from the week that holds the start date.
      const firstSunday = addDays(start, -weekdayOf(start));
      const weekStart = addDays(firstSunday, step * every * 7);
      for (const d of days) {
        const date = addDays(weekStart, d);
        if (date >= start) yield date;
      }
    } else if (rule.frequency === "monthly") {
      const month = addMonths(start.slice(0, 7), step * every);
      const date =
        rule.monthMode === "weekday"
          ? nthWeekdayInMonth(
              month,
              rule.weekdays[0] ?? weekdayOf(start),
              rule.nthWeek ?? Math.min(4, Math.ceil(Number(start.slice(8)) / 7)),
            )
          : dayInMonth(month, rule.dayOfMonth ?? Number(start.slice(8)));
      if (date >= start) yield date;
    } else {
      const month = addMonths(start.slice(0, 7), step * every * 12);
      const date = dayInMonth(month, Number(start.slice(8)));
      if (date >= start) yield date;
    }
  }
}

/** The dates from `from` to `to` (inclusive) on which the rule occurs. */
export function occurrences(rule: RepeatRule, from: string, to: string): string[] {
  const found: string[] = [];
  let count = 0;
  for (const date of generate(rule)) {
    if (rule.endDate && date > rule.endDate) break;
    if (date > to) break;
    count += 1;
    if (rule.maxCount !== null && count > rule.maxCount) break;
    if (date >= from) found.push(date);
  }
  return found;
}

/** The first few occurrences on or after `from`, for showing the user what a rule means. */
export function nextOccurrences(rule: RepeatRule, from: string, howMany: number): string[] {
  const found: string[] = [];
  let count = 0;
  for (const date of generate(rule)) {
    if (rule.endDate && date > rule.endDate) break;
    count += 1;
    if (rule.maxCount !== null && count > rule.maxCount) break;
    if (date >= from) {
      found.push(date);
      if (found.length >= howMany) break;
    }
  }
  return found;
}

/** A message for the first thing wrong with a rule, or null when it is fine. */
export function ruleProblem(rule: RepeatRule): string | null {
  if (!isRealDate(rule.startDate)) return "Enter a real start date as YYYY-MM-DD.";
  if (!Number.isInteger(rule.repeatEvery) || rule.repeatEvery < 1 || rule.repeatEvery > 365) {
    return "Repeat every must be a whole number from 1 to 365.";
  }
  if (rule.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return "Days of the week must be Sunday (0) to Saturday (6).";
  }
  if (rule.frequency === "weekly" && rule.weekdays.length === 0) {
    return "Choose at least one day of the week.";
  }
  if (
    rule.dayOfMonth !== null &&
    rule.dayOfMonth !== -1 &&
    (rule.dayOfMonth < 1 || rule.dayOfMonth > 31)
  ) {
    return "The day of the month must be 1 to 31, or the last day.";
  }
  if (rule.nthWeek !== null && ![1, 2, 3, 4, -1].includes(rule.nthWeek)) {
    return "Choose the 1st, 2nd, 3rd, 4th, or last weekday of the month.";
  }
  if (rule.endDate !== null) {
    if (!isRealDate(rule.endDate)) return "Enter a real end date as YYYY-MM-DD.";
    if (rule.endDate < rule.startDate) return "The end date cannot be before the start date.";
  }
  if (rule.maxCount !== null && (!Number.isInteger(rule.maxCount) || rule.maxCount < 1)) {
    return "The number of occurrences must be a whole number of at least 1.";
  }
  return null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", [-1]: "last" };

function ordinalDay(n: number): string {
  if (n === -1) return "last day";
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** The rule in words, such as "Every 2 weeks on Mon, Wed" or "Monthly on the 2nd Tuesday". */
export function describeRule(rule: RepeatRule): string {
  const every = rule.repeatEvery;
  let text: string;
  switch (rule.frequency) {
    case "once":
      return "Does not repeat";
    case "daily":
      text = every === 1 ? "Every day" : `Every ${every} days`;
      break;
    case "weekly": {
      const days = [...rule.weekdays]
        .sort((a, b) => a - b)
        .map((d) => DAY_NAMES[d]!.slice(0, 3))
        .join(", ");
      text = `${every === 1 ? "Every week" : `Every ${every} weeks`}${days ? ` on ${days}` : ""}`;
      break;
    }
    case "monthly": {
      const when =
        rule.monthMode === "weekday"
          ? `the ${ORDINAL[rule.nthWeek ?? 1]} ${DAY_NAMES[rule.weekdays[0] ?? 0]}`
          : `the ${ordinalDay(rule.dayOfMonth ?? Number(rule.startDate.slice(8)))}`;
      text = `${every === 1 ? "Every month" : `Every ${every} months`} on ${when}`;
      break;
    }
    case "yearly":
      text = every === 1 ? "Every year" : `Every ${every} years`;
      break;
  }
  if (rule.endDate) text += `, until ${rule.endDate}`;
  else if (rule.maxCount !== null) {
    text += `, ${rule.maxCount} time${rule.maxCount === 1 ? "" : "s"}`;
  }
  return text;
}
