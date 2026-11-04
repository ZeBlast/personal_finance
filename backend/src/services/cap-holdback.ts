import { addDays } from "../utils/dates.js";
import type { BudgetDto } from "./budget.service.js";

/** A category and the categories above it, nearest first. Pure; guards against a loop. */
function lineage(id: number, parentOf: Map<number, number | null>): number[] {
  const out = [id];
  for (let next = parentOf.get(id) ?? null; next !== null && out.length < 10;) {
    out.push(next);
    next = parentOf.get(next) ?? null;
  }
  return out;
}

/**
 * What to hold back in the cash forecast for the rest of this month's spending caps: for each cap,
 * what is left of it less the spending already forecast in its categories (so nothing is counted
 * twice), never below 0 (an overspent cap holds back nothing, it never adds money). The total is
 * spread evenly over the days left in the month, tomorrow to the last day; the last day takes the
 * remainder. A cap on a subcategory whose parent is also capped is skipped: the parent's cap already
 * contains it. Pure.
 *
 * `forecastOut` is the spending already in the forecast (positive amounts), each on the day the
 * charge is made (for a card, the day it is charged to the card, not the day the bill is paid).
 */
export function capHoldBack(input: {
  today: string;
  caps: Array<Pick<BudgetDto, "categoryId" | "categoryName" | "remainingMinor">>;
  parentOf: Map<number, number | null>;
  forecastOut: Array<{ date: string; categoryId: number; amountMinor: number }>;
}): {
  days: Array<{ date: string; amountMinor: number }>;
  caps: Array<{ categoryName: string; heldMinor: number; alreadyForecastMinor: number }>;
  totalMinor: number;
} {
  const { today, caps, parentOf, forecastOut } = input;
  const monthEnd = `${today.slice(0, 7)}-31`;
  const dates: string[] = [];
  for (let d = addDays(today, 1); d.slice(0, 7) === today.slice(0, 7) && d <= monthEnd;) {
    dates.push(d);
    d = addDays(d, 1);
  }
  if (dates.length === 0) return { days: [], caps: [], totalMinor: 0 };

  const capped = new Set(caps.map((c) => c.categoryId));
  const first = dates[0]!;
  const last = dates.at(-1)!;
  const held: Array<{ categoryName: string; heldMinor: number; alreadyForecastMinor: number }> = [];
  for (const cap of caps) {
    if (
      lineage(cap.categoryId, parentOf)
        .slice(1)
        .some((id) => capped.has(id))
    )
      continue;
    const already = forecastOut
      .filter(
        (f) =>
          f.date >= first &&
          f.date <= last &&
          lineage(f.categoryId, parentOf).includes(cap.categoryId),
      )
      .reduce((n, f) => n + f.amountMinor, 0);
    const heldMinor = Math.max(0, cap.remainingMinor - already);
    if (heldMinor > 0) {
      held.push({ categoryName: cap.categoryName, heldMinor, alreadyForecastMinor: already });
    }
  }

  const totalMinor = held.reduce((n, c) => n + c.heldMinor, 0);
  const each = Math.floor(totalMinor / dates.length);
  const days = dates
    .map((date, i) => ({
      date,
      amountMinor: i === dates.length - 1 ? totalMinor - each * (dates.length - 1) : each,
    }))
    .filter((d) => d.amountMinor > 0);
  return { days, caps: held, totalMinor };
}
