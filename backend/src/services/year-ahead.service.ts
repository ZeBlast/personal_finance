import type { AppDb } from "../db/client.js";
import { addMonths, firstOfMonth, isRealDate, lastOfMonth, monthOf } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { budgetMonth } from "./budget.service.js";
import { listOccurrences } from "./calendar.service.js";
import { listCategories } from "./category.service.js";
import { debtOverview } from "./debt.service.js";
import { listGoals } from "./goal.service.js";
import { activeSeries, planDatesIn } from "./plan-dates.js";
import { getSettings } from "./settings.service.js";

/**
 * The year ahead: the next twelve months, each with what is expected to come in and go out, and
 * the lumpy things that make one month unlike the others: yearly and quarterly bills, one-off
 * expected payments, months with an extra paycheck, goal dates, debts paid off and the dates
 * saved-up funds are for. Month by month rather than day by day, so it can look a year out.
 */

export type YearItemKind =
  | "yearly"
  | "quarterly"
  | "planned"
  | "extra_paycheck"
  | "goal_date"
  | "debt_paid_off"
  | "fund_target";

export interface YearItem {
  date: string;
  label: string;
  /** Positive is money coming in, negative going out (or still to set aside); 0 for a milestone. */
  amountMinor: number;
  kind: YearItemKind;
}

export interface YearMonth {
  month: string;
  incomeMinor: number;
  /** Recurring and expected payments outside capped categories. */
  billsMinor: number;
  capsMinor: number;
  netMinor: number;
  short: boolean;
  items: YearItem[];
}

export interface YearAhead {
  currency: string;
  today: string;
  months: YearMonth[];
}

const MONTHS = 12;
/** How many paydays a month usually has on a schedule; one more is an extra paycheck. */
const USUAL_PAYDAYS: Partial<Record<string, number>> = { weekly: 4, biweekly: 2 };

export function yearAhead(db: AppDb, options: { today?: string | undefined } = {}): YearAhead {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const settings = getSettings(db);
  const first = monthOf(today);
  const months = Array.from({ length: MONTHS }, (_, k) => addMonths(first, k));
  const start = firstOfMonth(first);
  const end = lastOfMonth(months[MONTHS - 1]!);

  const parentOf = new Map(listCategories(db, true).map((c) => [c.id, c.parentId]));
  const series = activeSeries(db, today);
  const occurrences = listOccurrences(db, start, end, { includeResolved: true }).filter(
    (o) => o.status !== "skipped",
  );
  const goals = listGoals(db, today).filter((g) => !g.reached && g.targetDate !== null);
  const payoffs = debtOverview(db, { extraMinor: settings.debtExtraInForecastMinor }).plan.debts;

  const out = months.map((month, index): YearMonth => {
    const from = firstOfMonth(month);
    const to = lastOfMonth(month);
    const caps = budgetMonth(db, month, settings.plaidEnvironment, { today });
    const capped = new Set(caps.budgets.map((b) => b.categoryId));
    const isCapped = (id: number | null): boolean =>
      id !== null && (capped.has(id) || capped.has(parentOf.get(id) ?? -1));
    const items: YearItem[] = [];
    let incomeMinor = 0;
    let billsMinor = 0;
    const count = (direction: "in" | "out", amount: number, categoryId: number | null): void => {
      if (direction === "in") incomeMinor += amount;
      else if (!isCapped(categoryId)) billsMinor += amount;
    };

    for (const s of series) {
      const dates = planDatesIn(s, from, to);
      count(s.direction, s.typicalAmountMinor * dates.length, s.categoryId);
      if (s.cadence === "yearly" || s.cadence === "quarterly") {
        for (const date of dates) {
          items.push({
            date,
            label: s.merchant,
            amountMinor: s.direction === "in" ? s.typicalAmountMinor : -s.typicalAmountMinor,
            kind: s.cadence,
          });
        }
      }
      const usual = USUAL_PAYDAYS[s.cadence];
      if (s.direction === "in" && usual !== undefined && dates.length > usual) {
        items.push({
          date: dates[dates.length - 1]!,
          label: `${s.merchant}: an extra paycheck`,
          amountMinor: s.typicalAmountMinor,
          kind: "extra_paycheck",
        });
      }
    }

    for (const o of occurrences) {
      if (o.date < from || o.date > to) continue;
      count(o.direction, o.amountMinor, o.categoryId);
      if (!o.recurring) {
        items.push({
          date: o.date,
          label: o.merchant,
          amountMinor: o.direction === "in" ? o.amountMinor : -o.amountMinor,
          kind: "planned",
        });
      }
    }

    for (const g of goals) {
      if (g.targetDate! < from || g.targetDate! > to) continue;
      items.push({
        date: g.targetDate!,
        label: `${g.name} is due`,
        amountMinor: -g.remainingMinor,
        kind: "goal_date",
      });
    }
    for (const d of payoffs) {
      if (d.payoffMonth !== index) continue;
      items.push({ date: to, label: `${d.name} paid off`, amountMinor: 0, kind: "debt_paid_off" });
    }
    for (const b of caps.budgets) {
      const fund = b.fund;
      if (!fund || fund.targetDate < from || fund.targetDate > to) continue;
      items.push({
        date: fund.targetDate,
        label: `${b.categoryName} fund`,
        amountMinor: -fund.targetMinor,
        kind: "fund_target",
      });
    }

    const capsMinor = caps.budgets.reduce((n, b) => n + b.amountMinor, 0);
    const netMinor = incomeMinor - billsMinor - capsMinor;
    items.sort((a, b) => a.date.localeCompare(b.date));
    return { month, incomeMinor, billsMinor, capsMinor, netMinor, short: netMinor < 0, items };
  });

  return { currency: settings.currency, today, months: out };
}
