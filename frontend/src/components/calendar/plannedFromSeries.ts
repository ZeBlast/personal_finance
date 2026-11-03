import type { ForecastEvent } from "../../types/calendar";
import { weekdayOf } from "./range";

/**
 * A plan for a recurring item found in the history, starting on one of its forecast days: the
 * same merchant, amount and schedule. One paid with a card bill starts on the day it is charged,
 * on that card. Null for a schedule plans cannot express (twice a month).
 */
export function planFromCadence(
  e: ForecastEvent,
  forecastDay: string,
): Record<string, unknown> | null {
  const day = e.chargedOn ?? forecastDay;
  const base = {
    merchant: e.label,
    amountMinor: Math.abs(e.amountMinor),
    direction: e.amountMinor > 0 ? "in" : "out",
    startDate: day,
    ...(e.card !== undefined && e.accountId !== undefined ? { accountId: e.accountId } : {}),
  };
  const dayOfMonth = Number(day.slice(8));
  switch (e.cadence) {
    case "weekly":
    case "biweekly":
      return {
        ...base,
        frequency: "weekly",
        repeatEvery: e.cadence === "weekly" ? 1 : 2,
        weekdays: [weekdayOf(day)],
      };
    case "monthly":
    case "quarterly":
      return {
        ...base,
        frequency: "monthly",
        repeatEvery: e.cadence === "monthly" ? 1 : 3,
        monthMode: "day",
        dayOfMonth,
      };
    case "yearly":
      return { ...base, frequency: "yearly" };
    default:
      return null;
  }
}
