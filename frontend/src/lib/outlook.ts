import type { OutlookInputs } from "../types/planTools";

/**
 * The long-range outlook: net worth year by year at three steady growth rates. Pure.
 *
 * Each year the investments grow by the rate and a year of saving is added to them; cash and other
 * assets stay as they are (in today's money); debt follows the payoff plan, month by month, and is
 * gone once the plan has paid it off. Debt the plan leaves out stays as it is.
 *
 * Saving is what is left over each month after spending. Card payments are not spending, so while
 * the plan is paying debt they come out of that; once it is paid off, the loan payments (which
 * were spending) are saved too. It is an estimate: steady rates, no inflation, no taxes.
 */

export interface OutlookOptions {
  years: number;
  savingPerMonthMinor: number;
  /** Yearly growth: low, middle, high (0.05 is 5%). */
  rates: readonly [number, number, number];
  /** Savings this many times a year's spending is the work-optional number. */
  multiple: number;
}

export interface OutlookPoint {
  year: number;
  low: number;
  mid: number;
  high: number;
}

export interface Outlook {
  points: OutlookPoint[];
  /** Years from now until the middle rate reaches the work-optional number, or null. */
  workOptionalYear: number | null;
  /** Years from now until the debt payoff plan is done, or null when it never is. */
  debtFreeYear: number | null;
}

/** A month's saving to start from: income less spending, never below zero. Pure. */
export function defaultSaving(i: OutlookInputs): number {
  return Math.max(0, i.monthlyIncomeMinor - i.monthlySpendingMinor);
}

/** What is still owed `months` from now under the plan. Pure. */
function debtAt(i: OutlookInputs, months: number): number {
  const b = i.debtBalances;
  if (months < b.length) return b[months]!;
  // Past the plan's end: paid off, unless the payments never catch up.
  return i.debtFreeMonths === null ? (b[b.length - 1] ?? i.debtMinor) : 0;
}

export function projectOutlook(i: OutlookInputs, o: OutlookOptions): Outlook {
  const startYear = Number(i.today.slice(0, 4));
  const invested = [i.investmentsMinor, i.investmentsMinor, i.investmentsMinor];
  const target = o.multiple * i.monthlySpendingMinor * 12;
  let workOptionalYear: number | null = null;
  const points: OutlookPoint[] = [];
  for (let k = 0; k <= o.years; k += 1) {
    if (k > 0) {
      const paying = debtAt(i, (k - 1) * 12) > 0;
      const perMonth = paying
        ? Math.max(0, o.savingPerMonthMinor - i.debtPayments.cardMinor)
        : o.savingPerMonthMinor + i.debtPayments.loanMinor;
      for (let r = 0; r < 3; r += 1) {
        invested[r] = invested[r]! * (1 + o.rates[r]!) + perMonth * 12;
      }
    }
    const fixed = i.cashMinor + i.otherAssetsMinor - debtAt(i, k * 12) - i.debtOutsidePlanMinor;
    const [low, mid, high] = invested.map((v) => Math.round(fixed + v)) as [number, number, number];
    points.push({ year: startYear + k, low, mid, high });
    if (workOptionalYear === null && target > 0 && i.cashMinor + invested[1]! >= target) {
      workOptionalYear = k;
    }
  }
  return {
    points,
    workOptionalYear,
    debtFreeYear:
      i.debtFreeMonths === null || i.debtOutsidePlanMinor > 0
        ? null
        : Math.ceil(i.debtFreeMonths / 12),
  };
}
