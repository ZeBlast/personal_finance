import type { AppDb } from "../db/client.js";
import {
  addMonths,
  firstOfMonth,
  isRealDate,
  isRealMonth,
  lastOfMonth,
  monthOf,
} from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { summarize } from "./analytics.service.js";
import { budgetMonth } from "./budget.service.js";
import { listOccurrences } from "./calendar.service.js";
import { listCategories } from "./category.service.js";
import { listGoals } from "./goal.service.js";
import {
  activeSeries,
  planDatesIn,
  sameMerchant,
  topOf,
  usualByLeaf,
  usualLines,
} from "./plan-dates.js";
import { getSettings } from "./settings.service.js";

/**
 * The month plan: a month's expected income next to everything it has to cover, and what is left.
 *
 *   left = income − bills − spending caps − usual spending without a cap − goals − extra on debt
 *
 * Bills are the recurring and expected charges outside any capped category: a charge in a capped
 * category (a power bill under a utilities cap) is already inside the cap, so it counts once.
 */

export const KINDS = ["income", "bill", "cap", "usual", "goal", "debt"] as const;
export type PlanKind = (typeof KINDS)[number];

export interface PlanLine {
  kind: PlanKind;
  label: string;
  /** Always positive; the kind says which way it goes. */
  amountMinor: number;
  note?: string;
}

export interface MonthPlan {
  currency: string;
  month: string;
  today: string;
  lines: PlanLine[];
  totals: Record<PlanKind, number>;
  /** Income less everything else; below 0 when the plan is short. */
  leftMinor: number;
  /** What actually came in and went out so far, or null for a month that has not started. */
  actual: { incomeMinor: number; spendingMinor: number; through: string } | null;
}

/** How far back and ahead a plan can be asked for, in months from today's. */
const MONTHS_BACK = 12;
const MONTHS_AHEAD = 6;

export function monthPlan(
  db: AppDb,
  options: { month?: string | undefined; today?: string | undefined } = {},
): MonthPlan {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const thisMonth = monthOf(today);
  const month = options.month ?? thisMonth;
  if (
    !isRealMonth(month) ||
    month < addMonths(thisMonth, -MONTHS_BACK) ||
    month > addMonths(thisMonth, MONTHS_AHEAD)
  ) {
    throw new AppError(
      400,
      "month_out_of_range",
      `Pick a month from ${MONTHS_BACK} months ago to ${MONTHS_AHEAD} months ahead.`,
    );
  }
  const settings = getSettings(db);
  const from = firstOfMonth(month);
  const to = lastOfMonth(month);

  // Caps cover their category and its subcategories; a subcategory's cap under a capped parent
  // is already inside the parent's, so only the parent counts (as on the Spending caps page).
  const caps = budgetMonth(db, month, settings.plaidEnvironment, { today });
  const categories = listCategories(db, true);
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));
  const capped = new Set(caps.budgets.map((b) => b.categoryId));
  const isCapped = (id: number | null): boolean =>
    id !== null && (capped.has(id) || capped.has(parentOf.get(id) ?? -1));

  const lines: PlanLine[] = [];
  /** A month's worth of the bills in each top-level category, to take off its usual spending. */
  const billsByTop = new Map<number, number>();
  const addMoney = (
    direction: "in" | "out",
    label: string,
    amountMinor: number,
    categoryId: number | null,
    monthlyMinor: number,
    note?: string,
  ): void => {
    if (amountMinor <= 0) return;
    if (direction === "in") {
      lines.push({ kind: "income", label, amountMinor, ...(note ? { note } : {}) });
      return;
    }
    if (isCapped(categoryId)) return;
    lines.push({ kind: "bill", label, amountMinor, ...(note ? { note } : {}) });
    const top = topOf(categoryId, parentOf);
    billsByTop.set(top, (billsByTop.get(top) ?? 0) + monthlyMinor);
  };

  // Each expected transaction the user entered, added up over the month.
  const occurrences = listOccurrences(db, from, to, { includeResolved: true }).filter(
    (o) => o.status !== "skipped",
  );
  const planned = new Map<
    number,
    {
      label: string;
      direction: "in" | "out";
      amount: number;
      category: number | null;
      times: number;
      recurring: boolean;
    }
  >();
  for (const o of occurrences) {
    const p = planned.get(o.plannedId) ?? {
      label: o.merchant,
      direction: o.direction,
      amount: 0,
      category: o.categoryId,
      times: 0,
      recurring: o.recurring,
    };
    p.amount += o.amountMinor;
    p.times += 1;
    planned.set(o.plannedId, p);
  }

  // A detected series counts unless the user expects a payment to the same payee this month
  // (that one counts instead, as in the cash forecast).
  for (const s of activeSeries(db, today)) {
    if (occurrences.some((o) => sameMerchant(o.merchant, s.merchant))) continue;
    const dates = planDatesIn(s, from, to);
    if (dates.length === 0) continue;
    const note = dates.length > 1 ? `${dates.length} times this month` : undefined;
    const amount = s.typicalAmountMinor * dates.length;
    addMoney(s.direction, s.merchant, amount, s.categoryId, s.perMonthMinor, note);
  }
  for (const p of planned.values()) {
    const note = p.times > 1 ? `${p.times} times this month` : undefined;
    // A one-off is not in the usual months, so it takes nothing off them.
    addMoney(p.direction, p.label, p.amount, p.category, p.recurring ? p.amount : 0, note);
  }

  for (const b of caps.budgets) {
    if (b.parentId !== null && capped.has(b.parentId)) continue;
    lines.push({ kind: "cap", label: b.categoryName, amountMinor: b.amountMinor });
  }
  // A month not yet over goes by the months just before today.
  const usualBase = month < thisMonth ? month : thisMonth;
  const byLeaf = usualByLeaf(db, settings.plaidEnvironment, usualBase);
  for (const u of usualLines(byLeaf, parentOf, nameOf, isCapped, billsByTop)) {
    lines.push({ kind: "usual", label: u.label, amountMinor: u.amountMinor });
  }

  for (const g of listGoals(db, today)) {
    if (g.reached) continue;
    const monthly = g.forecast?.monthlyMinor ?? g.perMonthMinor;
    if (monthly !== null && monthly > 0) {
      lines.push({ kind: "goal", label: g.name, amountMinor: monthly });
    }
  }
  if (settings.debtExtraInForecastMinor > 0) {
    lines.push({
      kind: "debt",
      label: "Extra toward debt",
      amountMinor: settings.debtExtraInForecastMinor,
    });
  }

  const totals: Record<PlanKind, number> = {
    income: 0,
    bill: 0,
    cap: 0,
    usual: 0,
    goal: 0,
    debt: 0,
  };
  for (const l of lines) totals[l.kind] += l.amountMinor;
  lines.sort(
    (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.amountMinor - a.amountMinor,
  );

  let actual: MonthPlan["actual"] = null;
  if (from <= today) {
    const through = to < today ? to : today;
    const s = summarize(db, {
      from,
      to: through,
      groupBy: "none",
      includeTransfers: false,
      includePending: true,
      fill: false,
      environment: settings.plaidEnvironment,
    });
    actual = { incomeMinor: s.totals.incomeMinor, spendingMinor: s.totals.spendingMinor, through };
  }

  return {
    currency: settings.currency,
    month,
    today,
    lines,
    totals,
    leftMinor: totals.income - totals.bill - totals.cap - totals.usual - totals.goal - totals.debt,
    actual,
  };
}
