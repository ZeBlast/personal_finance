import { today } from "./period";
import type { Granularity } from "../types/data";

/** The most days a daily series asks for, so the chart stays readable and the request stays small. */
export const MAX_DAILY_DAYS = 1000;

/** `YYYY-MM-DD` this many days before `day`. */
export function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The request for a net worth series: how many days back (a daily series is capped, because a point
 * a day for many years is more than a chart can show).
 */
export function seriesPath(granularity: string, rangeDays: number, now: string = today()): string {
  const g: Granularity = granularity === "day" || granularity === "month" ? granularity : "week";
  const days = g === "day" ? Math.min(rangeDays, MAX_DAILY_DAYS) : rangeDays;
  // "Everything" asks for as far back as there is data.
  const from = days >= 36500 ? "" : `&from=${daysBefore(now, days)}`;
  return `/analytics/net-worth-series?granularity=${g}${from}`;
}

/** How the accounts in one point were known, in words: "2 recorded, 1 rebuilt from transactions". */
export function basisText(accounts: {
  recorded: number;
  rebuilt: number;
  carried: number;
}): string {
  const parts: string[] = [];
  if (accounts.recorded > 0) parts.push(`${accounts.recorded} recorded`);
  if (accounts.rebuilt > 0) parts.push(`${accounts.rebuilt} rebuilt from transactions`);
  if (accounts.carried > 0) parts.push(`${accounts.carried} carried forward`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** The label of one period for a table: a day, a week starting on a day, or a month. */
export function periodLabel(
  granularity: Granularity,
  point: { date: string; periodStart: string },
  format: (day: string) => string,
  monthName: (day: string) => string,
): string {
  if (granularity === "day") return format(point.date);
  if (granularity === "month") return monthName(point.date);
  return point.periodStart === point.date
    ? format(point.date)
    : `${format(point.periodStart)} to ${format(point.date)}`;
}
