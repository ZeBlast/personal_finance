import type { AppDb } from "../db/client.js";
import { addMonths, firstOfMonth, isRealDate, lastOfMonth, monthOf } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { summarize } from "./analytics.service.js";
import { briefCashAccounts, goalMoneyInCash } from "./brief.service.js";
import { listCategories } from "./category.service.js";
import { getSettings } from "./settings.service.js";

/**
 * The safety net: how many months the cash in the bank accounts would cover the spending the user
 * cannot go without, if money stopped coming in.
 *
 *   months = (cash − what goals hold in it) / a usual month of essential spending
 *
 * A usual month is the average of the three complete months before this one. Without chosen
 * essentials, all spending counts (a harsher, but honest, figure).
 */

export interface SafetyNet {
  currency: string;
  /** Cash in the bank accounts the daily brief counts. */
  cashMinor: number;
  /** What goals hold in that cash. */
  reservedMinor: number;
  freeCashMinor: number;
  /** A usual month of the spending counted. */
  monthlyMinor: number;
  /** Which spending was counted: the essentials chosen, or all of it when none are. */
  basis: "essential" | "all";
  /** How many of the three months had any spending (at least 1). */
  monthsAveraged: number;
  /** Months the free cash covers, to one decimal, or null with no spending to cover. */
  months: number | null;
  /** The essentials chosen (top-level ones, with their subcategories added in), biggest first. */
  essentials: Array<{ id: number; name: string; monthlyMinor: number }>;
}

/** Months of `monthlyMinor` that `freeCashMinor` covers, to one decimal; never below 0. Pure. */
export function runwayMonths(freeCashMinor: number, monthlyMinor: number): number | null {
  if (monthlyMinor <= 0) return null;
  return Math.max(0, Math.floor((freeCashMinor / monthlyMinor) * 10) / 10);
}

const MONTHS_AVERAGED = 3;

export function safetyNet(db: AppDb, options: { today?: string | undefined } = {}): SafetyNet {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const settings = getSettings(db);

  const accounts = briefCashAccounts(db, settings);
  const cashMinor = accounts.reduce((n, a) => n + (a.currentBalanceMinor ?? 0), 0);
  const { reservedMinor } = goalMoneyInCash(db, accounts);
  const freeCashMinor = cashMinor - reservedMinor;

  // Each chosen essential that still exists, with its subcategories (spending is per category).
  const active = listCategories(db, false);
  const chosen = active.filter((c) => settings.essentialCategoryIds.includes(c.id));
  const top = chosen.filter((c) => c.parentId === null || !chosen.some((p) => p.id === c.parentId));
  const owner = new Map<number, number>();
  for (const c of top) {
    owner.set(c.id, c.id);
    for (const sub of active) if (sub.parentId === c.id) owner.set(sub.id, c.id);
  }
  const basis = top.length > 0 ? "essential" : "all";

  const thisMonth = monthOf(today);
  const perEssential = new Map<number, number>();
  let total = 0;
  let monthsWithSpending = 0;
  for (let k = 1; k <= MONTHS_AVERAGED; k += 1) {
    const month = addMonths(thisMonth, -k);
    const summary = summarize(db, {
      from: firstOfMonth(month),
      to: lastOfMonth(month),
      groupBy: "category",
      includeTransfers: false,
      includePending: false,
      fill: false,
      environment: settings.plaidEnvironment,
    });
    if (summary.totals.spendingMinor > 0) monthsWithSpending += 1;
    for (const row of summary.rows) {
      if (basis === "all") {
        total += row.spendingMinor;
        continue;
      }
      const id = owner.get(Number(row.key));
      if (id === undefined) continue;
      total += row.spendingMinor;
      perEssential.set(id, (perEssential.get(id) ?? 0) + row.spendingMinor);
    }
  }
  const monthsAveraged = Math.max(1, monthsWithSpending);
  const monthlyMinor = Math.round(total / monthsAveraged);

  return {
    currency: settings.currency,
    cashMinor,
    reservedMinor,
    freeCashMinor,
    monthlyMinor,
    basis,
    monthsAveraged,
    months: runwayMonths(freeCashMinor, monthlyMinor),
    essentials: top
      .map((c) => ({
        id: c.id,
        name: c.name,
        monthlyMinor: Math.round((perEssential.get(c.id) ?? 0) / monthsAveraged),
      }))
      .sort((a, b) => b.monthlyMinor - a.monthlyMinor),
  };
}
