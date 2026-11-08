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
import { activeSeries, planDatesIn } from "./plan-dates.js";
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

  // Caps cover their category and its subcategories.
  const caps = budgetMonth(db, month, settings.plaidEnvironment, { today, detail: true });
  const categories = listCategories(db, true);
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const capped = new Set(caps.budgets.map((b) => b.categoryId));
  const isCapped = (id: number | null): boolean =>
    id !== null && (capped.has(id) || capped.has(parentOf.get(id) ?? -1));

  const lines: PlanLine[] = [];
  const billsByCategory = new Map<number, number>();
  const addMoney = (
    direction: "in" | "out",
    label: string,
    amountMinor: number,
    categoryId: number | null,
    note?: string,
  ): void => {
    if (amountMinor <= 0) return;
    if (direction === "in") {
      lines.push({ kind: "income", label, amountMinor, ...(note ? { note } : {}) });
      return;
    }
    if (isCapped(categoryId)) return;
    lines.push({ kind: "bill", label, amountMinor, ...(note ? { note } : {}) });
    if (categoryId !== null) {
      const top = parentOf.get(categoryId) ?? categoryId;
      for (const id of new Set([categoryId, top])) {
        billsByCategory.set(id, (billsByCategory.get(id) ?? 0) + amountMinor);
      }
    }
  };

  for (const s of activeSeries(db, today)) {
    const dates = planDatesIn(s, from, to);
    if (dates.length === 0) continue;
    const note = dates.length > 1 ? `${dates.length} times this month` : undefined;
    addMoney(s.direction, s.merchant, s.typicalAmountMinor * dates.length, s.categoryId, note);
  }
  // Each expected transaction the user entered, added up over the month.
  const planned = new Map<
    number,
    {
      label: string;
      direction: "in" | "out";
      amount: number;
      category: number | null;
      times: number;
    }
  >();
  for (const o of listOccurrences(db, from, to, { includeResolved: true })) {
    if (o.status === "skipped") continue;
    const p = planned.get(o.plannedId) ?? {
      label: o.merchant,
      direction: o.direction,
      amount: 0,
      category: o.categoryId,
      times: 0,
    };
    p.amount += o.amountMinor;
    p.times += 1;
    planned.set(o.plannedId, p);
  }
  for (const p of planned.values()) {
    const note = p.times > 1 ? `${p.times} times this month` : undefined;
    addMoney(p.direction, p.label, p.amount, p.category, note);
  }

  for (const b of caps.budgets) {
    lines.push({ kind: "cap", label: b.categoryName, amountMinor: b.amountMinor });
  }
  for (const u of caps.uncapped ?? []) {
    const usual = u.averageMinor - (billsByCategory.get(u.categoryId) ?? 0);
    if (usual > 0) lines.push({ kind: "usual", label: u.label, amountMinor: usual });
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
