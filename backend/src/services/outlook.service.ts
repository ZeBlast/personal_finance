import type { AppDb } from "../db/client.js";
import { addMonths, firstOfMonth, isRealDate, lastOfMonth, monthOf } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { overview, summarize } from "./analytics.service.js";
import { debtOverview } from "./debt.service.js";
import { listGoals } from "./goal.service.js";
import { getSettings } from "./settings.service.js";

/**
 * What the long-range outlook starts from: today's balances, a usual month of income and spending,
 * the debt payoff plan and the goals. The projection itself is worked out on the page, so its
 * assumptions (growth, saving, years) can be changed without asking again.
 */

export interface OutlookInputs {
  currency: string;
  today: string;
  cashMinor: number;
  investmentsMinor: number;
  otherAssetsMinor: number;
  /** What is owed on cards and loans. */
  debtMinor: number;
  netWorthMinor: number;
  /** A usual month, from the complete months of the last twelve that had any money in or out. */
  monthlyIncomeMinor: number;
  monthlySpendingMinor: number;
  monthsAveraged: number;
  /** What is owed at the end of each month under the debt payoff plan (month 0 is now). */
  debtBalances: number[];
  /** Months until the plan pays everything off, or null when the payments never catch up. */
  debtFreeMonths: number | null;
  goals: Array<{ name: string; targetDate: string | null; remainingMinor: number }>;
}

const MONTHS_AVERAGED = 12;

export function outlookInputs(
  db: AppDb,
  options: { today?: string | undefined } = {},
): OutlookInputs {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const settings = getSettings(db);
  const now = overview(db);

  const lastComplete = addMonths(monthOf(today), -1);
  const summary = summarize(db, {
    from: firstOfMonth(addMonths(lastComplete, -(MONTHS_AVERAGED - 1))),
    to: lastOfMonth(lastComplete),
    groupBy: "month",
    includeTransfers: false,
    includePending: false,
    fill: false,
    environment: settings.plaidEnvironment,
  });
  const active = summary.rows.filter((r) => r.incomeMinor > 0 || r.spendingMinor > 0);
  const monthsAveraged = active.length;
  const average = (pick: (r: (typeof active)[number]) => number): number =>
    monthsAveraged === 0 ? 0 : Math.round(active.reduce((n, r) => n + pick(r), 0) / monthsAveraged);

  const plan = debtOverview(db, { extraMinor: settings.debtExtraInForecastMinor }).plan;

  return {
    currency: settings.currency,
    today,
    cashMinor: now.cashMinor,
    investmentsMinor: now.investmentsMinor,
    otherAssetsMinor: now.otherAssetsMinor,
    debtMinor: now.liabilitiesMinor,
    netWorthMinor: now.netWorthMinor,
    monthlyIncomeMinor: average((r) => r.incomeMinor),
    monthlySpendingMinor: average((r) => r.spendingMinor),
    monthsAveraged,
    debtBalances: plan.balances,
    debtFreeMonths: plan.months,
    goals: listGoals(db, today)
      .filter((g) => !g.reached)
      .map((g) => ({ name: g.name, targetDate: g.targetDate, remainingMinor: g.remainingMinor })),
  };
}
