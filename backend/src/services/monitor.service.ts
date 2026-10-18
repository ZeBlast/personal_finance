import type { AppDb } from "../db/client.js";
import { addMonths, isRealDate, lastOfMonth } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { summarize } from "./analytics.service.js";
import { getSettings } from "./settings.service.js";
import { tagByName } from "./tag.service.js";

/**
 * A spending monitor: spending narrowed to a category, account, merchant or tag (any mix), this
 * month so far next to the months before, and where the month is heading at its current pace.
 */

export interface MonitorFilter {
  category?: number | undefined;
  accountId?: number | undefined;
  merchant?: string | undefined;
  /** A tag's name. */
  tag?: string | undefined;
}

export interface SpendingMonitor {
  month: string;
  today: string;
  /** Spent this month up to today. */
  spentMinor: number;
  /** Where the month ends at the pace so far. */
  projectedMinor: number;
  /** The average of the last three whole months. */
  averageMinor: number;
  /** The average of the last three months up to the same day of the month: a fair comparison. */
  sameDayAverageMinor: number;
  /** spentMinor against sameDayAverageMinor, as a whole percent (null with no history). */
  changePercent: number | null;
  /** This month and the six before it, oldest first; the last is so far. */
  months: Array<{ month: string; spentMinor: number }>;
  /** A tag was named that does not exist. */
  unknownTag: boolean;
}

const MONTHS_BACK = 6;
const AVERAGE_OF = 3;

export function spendingMonitor(
  db: AppDb,
  filter: MonitorFilter,
  today = new Date().toISOString().slice(0, 10),
): SpendingMonitor {
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const environment = getSettings(db).plaidEnvironment;
  const month = today.slice(0, 7);
  const tag = filter.tag?.trim() ? tagByName(db, filter.tag) : undefined;
  const unknownTag = Boolean(filter.tag?.trim()) && tag === undefined;

  const spent = (from: string, to: string): number =>
    unknownTag
      ? 0
      : summarize(db, {
          from,
          to,
          groupBy: "none",
          category: filter.category,
          accountId: filter.accountId,
          merchant: filter.merchant,
          tagId: tag?.id,
          includeTransfers: false,
          includePending: true,
          fill: false,
          environment,
        }).totals.spendingMinor;

  const day = Number(today.slice(8, 10));
  const months: SpendingMonitor["months"] = [];
  const sameDay: number[] = [];
  for (let back = MONTHS_BACK; back >= 0; back -= 1) {
    const m = addMonths(month, -back);
    const last = lastOfMonth(m);
    months.push({ month: m, spentMinor: spent(`${m}-01`, back === 0 ? today : last) });
    if (back >= 1 && back <= AVERAGE_OF) {
      // The same day, or the month's last day when it is shorter.
      const upTo = Math.min(day, Number(last.slice(8, 10)));
      sameDay.push(spent(`${m}-01`, `${m}-${String(upTo).padStart(2, "0")}`));
    }
  }
  const spentMinor = months[months.length - 1]!.spentMinor;
  const whole = months.slice(-1 - AVERAGE_OF, -1);
  const averageMinor = Math.round(whole.reduce((n, m) => n + m.spentMinor, 0) / AVERAGE_OF);
  const sameDayAverageMinor = Math.round(sameDay.reduce((n, v) => n + v, 0) / AVERAGE_OF);
  const daysInMonth = Number(lastOfMonth(month).slice(8, 10));
  return {
    month,
    today,
    spentMinor,
    projectedMinor: Math.round((spentMinor / day) * daysInMonth),
    averageMinor,
    sameDayAverageMinor,
    changePercent:
      sameDayAverageMinor > 0
        ? Math.round(((spentMinor - sameDayAverageMinor) / sameDayAverageMinor) * 100)
        : null,
    months,
    unknownTag,
  };
}
