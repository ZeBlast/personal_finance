import type {
  AffordAnswer,
  MonthPlan,
  SafetyNet,
  YearAhead,
  YearItemKind,
} from "../types/planTools";
import { formatMinor } from "./money";
import { formatDay } from "./time";

const DAY_MS = 86_400_000;

const ITEM_LABEL: Record<YearItemKind, string> = {
  yearly: "Yearly",
  quarterly: "Quarterly",
  planned: "Expected",
  extra_paycheck: "Extra paycheck",
  goal_date: "Goal date",
  debt_paid_off: "Debt paid off",
  fund_target: "Fund date",
};

/** What kind of item a year-ahead entry is, in words. Pure. */
export function itemLabel(kind: YearItemKind): string {
  return ITEM_LABEL[kind];
}

/** The months of the year ahead where more goes out than comes in. Pure. */
export function shortMonths(y: YearAhead): string[] {
  return y.months.filter((m) => m.short).map((m) => m.month);
}

/**
 * Saving up `amountMinor` by `date`, starting this month: how many months that is (this one
 * through the date's, at least 1) and how much a month. Pure.
 */
export function fundPlan(
  amountMinor: number,
  date: string,
  thisMonth: string,
): { monthsLeft: number; perMonthMinor: number } {
  const [y1, m1] = thisMonth.split("-").map(Number) as [number, number];
  const [y2, m2] = date.split("-").map(Number) as [number, number];
  const monthsLeft = Math.max(1, (y2 - y1) * 12 + (m2 - m1) + 1);
  return { monthsLeft, perMonthMinor: Math.ceil(amountMinor / monthsLeft) };
}

/** What is left of a month's plan, in words. Pure. */
export function leftLine(
  p: MonthPlan,
  money: (n: number) => string,
): { text: string; tone: "good" | "short" } {
  if (p.lines.length === 0) return { text: "Nothing expected this month yet.", tone: "good" };
  if (p.leftMinor < 0) {
    return {
      text: `${money(-p.leftMinor)} short: the plan asks for more than comes in.`,
      tone: "short",
    };
  }
  if (p.leftMinor === 0) return { text: "Every dollar has a job.", tone: "good" };
  return { text: `${money(p.leftMinor)} not yet planned.`, tone: "good" };
}

/** Whether a purchase fits, in words: a headline answer and the figure behind it. Pure. */
export function affordSentence(
  a: AffordAnswer,
  money: (n: number) => string,
): { headline: string; detail: string; ok: boolean } {
  const lowLine = (low: { date: string; balanceMinor: number }) =>
    `Your cash is lowest on ${formatDay(low.date)} at ${money(low.balanceMinor)}, ${money(
      low.balanceMinor - a.floorMinor,
    )} above what you keep.`;
  let out: { headline: string; detail: string; ok: boolean };
  if (a.asked?.ok) {
    out = {
      ok: true,
      headline: `Yes, on ${formatDay(a.asked.date)}.`,
      detail: lowLine(a.asked.lowest),
    };
  } else if (a.asked && a.earliest) {
    out = {
      ok: false,
      headline: `Not on ${formatDay(a.asked.date)}. The earliest is ${formatDay(a.earliest.date)}.`,
      detail: lowLine(a.earliest.lowest),
    };
  } else if (!a.asked && a.earliest) {
    out = {
      ok: true,
      headline:
        a.earliest.date === a.today ? "Yes, today." : `Yes, from ${formatDay(a.earliest.date)}.`,
      detail: lowLine(a.earliest.lowest),
    };
  } else {
    const days = Math.round((Date.parse(a.horizonEnd) - Date.parse(a.today)) / DAY_MS);
    out = {
      ok: false,
      headline: `Not in the next ${days} days.`,
      detail: "Saving up for it gets you there:",
    };
  }
  if (a.alreadyShort) {
    out.detail = `${out.detail} Your forecast already dips below your goals and buffer.`;
  }
  return out;
}

/** Words for the planning tools' figures. Pure. */

const monthsWord = (n: number): string => `${n} ${n === 1 ? "month" : "months"}`;

/** The safety net in words: the headline, how it is worked out, and whether it meets the target. Pure. */
export function runwayText(
  s: SafetyNet,
  targetMonths: number,
): { headline: string; detail: string; tone: "good" | "warn" | "none" } {
  if (s.months === null) {
    return {
      headline: "No spending yet",
      detail: "Once a month of spending is in, this shows how long your cash would last.",
      tone: "none",
    };
  }
  const money = (n: number) => formatMinor(n, s.currency);
  const what = s.basis === "essential" ? "essentials" : "all spending";
  let detail = `${money(s.monthlyMinor)} a month of ${what}, from ${money(s.freeCashMinor)} after goals.`;
  if (s.basis === "all") detail += " Choose your essentials for a truer figure.";
  return {
    headline: monthsWord(s.months),
    detail,
    tone: s.months >= targetMonths ? "good" : "warn",
  };
}
