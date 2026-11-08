import type { AppDb } from "../db/client.js";
import { addDays, addMonths, isRealDate, lastOfMonth } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { briefCashAccounts, goalMoneyInCash } from "./brief.service.js";
import { cashForecast, lowestBalance } from "./forecast.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Can I afford it: what a purchase paid from the bank accounts on a day does to the cash forecast.
 * Paying on a day lowers every day from then on by the amount, so it fits when the lowest balance
 * from that day on stays at or above the floor: what goals hold in the cash, plus the buffer the
 * user keeps. When no day in the forecast fits, saving up for it is the answer.
 */

type Day = { date: string; balanceMinor: number };

export interface AffordAnswer {
  currency: string;
  today: string;
  amountMinor: number;
  bufferMinor: number;
  reservedMinor: number;
  floorMinor: number;
  /** The last day the forecast reaches. */
  horizonEnd: string;
  /** The forecast already falls below the floor somewhere, purchase or not. */
  alreadyShort: boolean;
  /** The day asked about, or null when none was. */
  asked: { date: string; ok: boolean; lowest: Day; marginMinor: number } | null;
  /** The first day it fits, or null when none in the forecast does. */
  earliest: { date: string; lowest: Day } | null;
  /** Saving up for it over 3, 6 or 12 months. */
  plans: Array<{ months: 3 | 6 | 12; perMonthMinor: number; by: string }>;
}

/** `out[i]` is the lowest balance of `days[i]` and every day after it. Pure. */
export function suffixLows(days: Day[]): number[] {
  const out = new Array<number>(days.length);
  let low = Infinity;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    low = Math.min(low, days[i]!.balanceMinor);
    out[i] = low;
  }
  return out;
}

/** The lowest day on or after index `from` (the earliest of equals). Pure. */
function lowestFrom(days: Day[], from: number): Day {
  let low = days[from]!;
  for (let i = from + 1; i < days.length; i += 1) {
    if (days[i]!.balanceMinor < low.balanceMinor) low = days[i]!;
  }
  return low;
}

/**
 * Paying `amountMinor` on `date`: whether every day from then on stays at or above the floor, and
 * the lowest of those days after paying. A date past the last day changes nothing seen. Pure.
 */
export function affordOn(
  days: Day[],
  amountMinor: number,
  floorMinor: number,
  date: string,
): { ok: boolean; lowest: Day } {
  const i = days.findIndex((d) => d.date >= date);
  if (i < 0) return { ok: true, lowest: { date, balanceMinor: -amountMinor } };
  const low = lowestFrom(days, i);
  const after = { date: low.date, balanceMinor: low.balanceMinor - amountMinor };
  return { ok: after.balanceMinor >= floorMinor, lowest: after };
}

/** The first day on which paying keeps every later day at or above the floor, or null. Pure. */
export function earliestAffordable(
  days: Day[],
  amountMinor: number,
  floorMinor: number,
): string | null {
  const lows = suffixLows(days);
  const i = lows.findIndex((low) => low - amountMinor >= floorMinor);
  return i < 0 ? null : days[i]!.date;
}

const PLAN_MONTHS = [3, 6, 12] as const;

/** The same day `months` later, or that month's last day when it is shorter. Pure. */
function sameDayIn(day: string, months: number): string {
  const month = addMonths(day.slice(0, 7), months);
  const wanted = `${month}-${day.slice(8, 10)}`;
  const last = lastOfMonth(month);
  return wanted < last ? wanted : last;
}

export function affordCheck(
  db: AppDb,
  options: {
    amountMinor: number;
    date?: string | undefined;
    bufferMinor?: number | undefined;
    days?: number | undefined;
    today?: string | undefined;
  },
): AffordAnswer {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const span = options.days ?? 90;
  const horizonEnd = addDays(today, span);
  const date = options.date;
  if (date !== undefined && (!isRealDate(date) || date < today || date > horizonEnd)) {
    throw new AppError(
      400,
      "date_out_of_range",
      `Pick a day from today to ${horizonEnd}, as far as the forecast reaches.`,
    );
  }
  const amount = options.amountMinor;
  const buffer = Math.max(0, options.bufferMinor ?? 0);
  const settings = getSettings(db);
  const { reservedMinor } = goalMoneyInCash(db, briefCashAccounts(db, settings));
  const floorMinor = reservedMinor + buffer;

  const forecast = cashForecast(db, { today, days: span });
  const days = forecast.days.map((d) => ({ date: d.date, balanceMinor: d.balanceMinor }));

  let asked: AffordAnswer["asked"] = null;
  if (date !== undefined) {
    const r = affordOn(days, amount, floorMinor, date);
    asked = { date, ok: r.ok, lowest: r.lowest, marginMinor: r.lowest.balanceMinor - floorMinor };
  }
  const first = earliestAffordable(days, amount, floorMinor);
  const earliest =
    first === null
      ? null
      : { date: first, lowest: affordOn(days, amount, floorMinor, first).lowest };

  return {
    currency: settings.currency,
    today,
    amountMinor: amount,
    bufferMinor: buffer,
    reservedMinor,
    floorMinor,
    horizonEnd,
    alreadyShort: days.length > 0 && lowestBalance(forecast) < floorMinor,
    asked,
    earliest,
    plans: PLAN_MONTHS.map((months) => ({
      months,
      perMonthMinor: Math.ceil(amount / months),
      by: sameDayIn(today, months),
    })),
  };
}
