import type { AppDb } from "../db/client.js";
import { addMonths, firstOfMonth, isRealMonth, lastOfMonth } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { summarize } from "./analytics.service.js";
import { budgetMonth } from "./budget.service.js";
import { netWorthHistory } from "./networth-history.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Longer views of spending: how merchants change from month to month, and how a whole year went.
 * Spending follows the same rules as everywhere else: moves between the user's own accounts and card
 * payments are left out, refunds reduce it, and pending transactions count.
 */

const BASE = { includeTransfers: false, includePending: true, fill: false } as const;

export interface MerchantTrend {
  merchant: string;
  /** Spending in each whole month, oldest first. */
  values: number[];
  /** Spending so far in the current month, which is not in `values`. */
  currentMinor: number;
  totalMinor: number;
  /** Of all spending in those months. */
  sharePercent: number;
  /** A month on average in the later half, and in the earlier half. */
  recentAverageMinor: number;
  earlierAverageMinor: number;
}

export interface MerchantTrends {
  currency: string;
  /** The whole months covered, oldest first. */
  months: string[];
  currentMonth: string;
  totalMinor: number;
  /** Enough months with data to say who is growing. */
  comparable: boolean;
  merchants: MerchantTrend[];
}

const MERCHANTS_SHOWN = 15;
const MAX_MONTHS = 24;

/** The merchants that took the most over the whole months before this one. */
export function merchantTrends(
  db: AppDb,
  input: { months?: number | undefined; category?: number | undefined; today?: string | undefined },
): MerchantTrends {
  const settings = getSettings(db);
  const environment = settings.plaidEnvironment;
  const count = Math.max(2, Math.min(MAX_MONTHS, input.months ?? 6));
  const currentMonth = (input.today ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
  const months = Array.from({ length: count }, (_, i) => addMonths(currentMonth, i - count));
  const query = (month: string) =>
    summarize(db, {
      ...BASE,
      from: firstOfMonth(month),
      to: lastOfMonth(month),
      groupBy: "merchant",
      environment,
      ...(input.category ? { category: input.category } : {}),
    });

  const byMerchant = new Map<string, number[]>();
  months.forEach((month, i) => {
    for (const row of query(month).rows) {
      if (row.spendingMinor <= 0) continue;
      const values = byMerchant.get(row.label) ?? new Array<number>(count).fill(0);
      values[i] = row.spendingMinor;
      byMerchant.set(row.label, values);
    }
  });
  const now = new Map(query(currentMonth).rows.map((r) => [r.label, r.spendingMinor]));

  const totalMinor = [...byMerchant.values()].flat().reduce((sum, v) => sum + v, 0);
  // Months before the first spending at all are months before there is history, not months of $0.
  const hasData = months.map((_, i) => [...byMerchant.values()].some((v) => v[i]! > 0));
  const start = Math.max(0, hasData.indexOf(true));
  const known = count - start;
  const comparable = hasData.includes(true) && known >= 2;
  const half = Math.floor(known / 2);
  const average = (values: number[]) =>
    values.length === 0 ? 0 : Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  const merchants = [...byMerchant.entries()]
    .map(([merchant, values]) => {
      const total = values.reduce((sum, v) => sum + v, 0);
      return {
        merchant,
        values,
        currentMinor: Math.max(0, now.get(merchant) ?? 0),
        totalMinor: total,
        sharePercent: totalMinor > 0 ? Math.round((total / totalMinor) * 1000) / 10 : 0,
        recentAverageMinor: average(values.slice(count - half)),
        earlierAverageMinor: average(values.slice(start, count - half)),
      };
    })
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, MERCHANTS_SHOWN);
  return { currency: settings.currency, months, currentMonth, totalMinor, comparable, merchants };
}

export interface YearMonth {
  month: string;
  incomeMinor: number;
  spendingMinor: number;
  savedMinor: number;
  /** Caps that held, of how many there were. */
  capsHeld: number;
  capsCount: number;
  /** Net worth at the month's end, or null without history. */
  netWorthMinor: number | null;
  /** A month not over yet: its figures are so far. */
  partial: boolean;
}

export interface YearReport {
  year: number;
  currency: string;
  /** The months from January through the current one. */
  months: YearMonth[];
  incomeMinor: number;
  spendingMinor: number;
  savedMinor: number;
  savingsRatePercent: number | null;
  /** The highest and lowest spending of the whole months. */
  highestMonth: string | null;
  lowestMonth: string | null;
  capsHeld: number;
  capsCount: number;
  categories: Array<{
    label: string;
    color: string | null;
    spendingMinor: number;
    sharePercent: number;
  }>;
  merchants: Array<{ label: string; spendingMinor: number }>;
  netWorth: { startMinor: number | null; endMinor: number | null; changeMinor: number | null };
}

const SHOWN = 8;

/** How a year went, month by month. */
export function yearReport(db: AppDb, year: number, today?: string): YearReport {
  if (!Number.isInteger(year) || !isRealMonth(`${year}-01`)) {
    throw new AppError(400, "invalid_year", "Year must be written YYYY.");
  }
  const settings = getSettings(db);
  const environment = settings.plaidEnvironment;
  const thisMonth = (today ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
  const list = Array.from(
    { length: 12 },
    (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`,
  ).filter((m) => m <= thisMonth);

  const from = `${year}-01-01`;
  const lastMonth = list.at(-1) ?? `${year}-12`;
  const to = lastOfMonth(lastMonth);
  const points = netWorthHistory(db, { from: `${year - 1}-12-01`, to }).points;
  const netWorthAt = (day: string): number | null => {
    const candidates = points.filter((p) => p.date <= day);
    return candidates.length ? candidates[candidates.length - 1]!.netWorthMinor : null;
  };

  const months: YearMonth[] = list.map((month) => {
    const { totals } = summarize(db, {
      ...BASE,
      from: firstOfMonth(month),
      to: lastOfMonth(month),
      groupBy: "none",
      environment,
    });
    const caps = budgetMonth(db, month, environment, { today: today }).budgets;
    return {
      month,
      incomeMinor: totals.incomeMinor,
      spendingMinor: totals.spendingMinor,
      savedMinor: totals.incomeMinor - totals.spendingMinor,
      capsHeld: caps.filter((c) => !c.overspent).length,
      capsCount: caps.length,
      netWorthMinor: netWorthAt(lastOfMonth(month)),
      partial: month === thisMonth,
    };
  });

  const incomeMinor = months.reduce((s, m) => s + m.incomeMinor, 0);
  const spendingMinor = months.reduce((s, m) => s + m.spendingMinor, 0);
  const whole = months.filter((m) => !m.partial && m.spendingMinor > 0);
  const ranked = [...whole].sort((a, b) => a.spendingMinor - b.spendingMinor);
  const range = { ...BASE, from, to, environment };
  const categories = summarize(db, { ...range, groupBy: "category", rollupToParent: true })
    .rows.filter((r) => r.spendingMinor > 0)
    .sort((a, b) => b.spendingMinor - a.spendingMinor)
    .slice(0, SHOWN)
    .map((r) => ({
      label: r.label,
      color: r.color,
      spendingMinor: r.spendingMinor,
      sharePercent:
        spendingMinor > 0 ? Math.round((r.spendingMinor / spendingMinor) * 1000) / 10 : 0,
    }));
  const merchants = summarize(db, { ...range, groupBy: "merchant" })
    .rows.filter((r) => r.spendingMinor > 0)
    .sort((a, b) => b.spendingMinor - a.spendingMinor)
    .slice(0, SHOWN)
    .map((r) => ({ label: r.label, spendingMinor: r.spendingMinor }));

  const startNw = netWorthAt(`${year - 1}-12-31`);
  const endNw = netWorthAt(to);
  return {
    year,
    currency: settings.currency,
    months,
    incomeMinor,
    spendingMinor,
    savedMinor: incomeMinor - spendingMinor,
    savingsRatePercent:
      incomeMinor > 0
        ? Math.round(((incomeMinor - spendingMinor) / incomeMinor) * 1000) / 10
        : null,
    highestMonth: ranked.at(-1)?.month ?? null,
    lowestMonth: ranked[0]?.month ?? null,
    capsHeld: months.reduce((s, m) => s + m.capsHeld, 0),
    capsCount: months.reduce((s, m) => s + m.capsCount, 0),
    categories,
    merchants,
    netWorth: {
      startMinor: startNw,
      endMinor: endNw,
      changeMinor: startNw !== null && endNw !== null ? endNw - startNw : null,
    },
  };
}
