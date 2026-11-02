import type { Forecast } from "../types/planning";
import type { DailyBrief } from "../widgets/DailyBriefWidget";
import { formatDay } from "./time";

/** Forecast days with an extra purchase on one day, carried through every day after it. Pure. */
export function withExtraSpend(
  days: Forecast["days"],
  amountMinor: number,
  onDate: string,
): Array<{ date: string; balanceMinor: number }> {
  return days.map((d) => ({
    date: d.date,
    balanceMinor: d.date >= onDate ? d.balanceMinor - amountMinor : d.balanceMinor,
  }));
}

/** The lowest point of a list of days; the earliest day when several tie. Pure. */
export function lowestOf<T extends { date: string; balanceMinor: number }>(days: T[]): T | null {
  return days.reduce<T | null>(
    (low, d) => (low === null || d.balanceMinor < low.balanceMinor ? d : low),
    null,
  );
}

export interface AttentionItem {
  text: string;
  to: string;
  tone: "warn" | "info";
}

/** What needs the user, most urgent first. Pure. */
export function attentionItems(input: {
  forecast: Forecast | null;
  brief: DailyBrief | null;
  capsOver: number;
  capsAtRisk: number;
  toReview: number;
  money: (minor: number) => string;
}): AttentionItem[] {
  const { forecast, brief, capsOver, capsAtRisk, toReview, money } = input;
  const items: AttentionItem[] = [];
  if (forecast && forecast.lowest.balanceMinor < 0) {
    items.push({
      text: `Cash goes to ${money(forecast.lowest.balanceMinor)} on ${formatDay(forecast.lowest.date)}`,
      to: "/planning",
      tone: "warn",
    });
  }
  for (const account of brief?.staleAccounts ?? []) {
    items.push({
      text: account.needsSignIn
        ? `${account.name} needs signing in again`
        : `${account.name} has not synced in over a day`,
      to: "/accounts",
      tone: account.needsSignIn ? "warn" : "info",
    });
  }
  if (capsOver > 0) {
    items.push({
      text: `${capsOver} spending cap${capsOver === 1 ? " is" : "s are"} over`,
      to: "/planning/budgets",
      tone: "warn",
    });
  }
  if (capsAtRisk > 0) {
    items.push({
      text: `${capsAtRisk} spending cap${capsAtRisk === 1 ? " is" : "s are"} heading over`,
      to: "/planning/budgets",
      tone: "info",
    });
  }
  if (toReview > 0) {
    items.push({
      text: `${toReview} transaction${toReview === 1 ? "" : "s"} to review`,
      to: "/transactions/review",
      tone: "info",
    });
  }
  return items;
}

// ---- The cash-flow map ---------------------------------------------------------------------

export interface FlowRow {
  key: string;
  label: string;
  color: string | null;
  spendingMinor: number;
  incomeMinor: number;
}

export interface FlowItem {
  key: string;
  label: string;
  color: string | null;
  amountMinor: number;
  kind: "source" | "shortfall" | "category" | "other" | "saved";
}

export interface FlowModel {
  sources: FlowItem[];
  targets: FlowItem[];
  incomeMinor: number;
  spendingMinor: number;
  /** What the two sides add up to: the same on both by construction. */
  totalMinor: number;
}

const FLOW_CATEGORIES = 9;

/**
 * Where a month's money came from and went. Whatever income did not cover shows as coming from
 * savings; what it left over shows as saved, so both sides always add up. Small categories fold into
 * "Everything else". Pure.
 */
export function cashFlowModel(rows: FlowRow[]): FlowModel {
  const sources: FlowItem[] = rows
    .filter((r) => r.incomeMinor > 0)
    .sort((a, b) => b.incomeMinor - a.incomeMinor)
    .map((r) => ({
      key: `in-${r.key}`,
      label: r.label,
      color: r.color,
      amountMinor: r.incomeMinor,
      kind: "source",
    }));
  const spending = rows
    .filter((r) => r.spendingMinor > 0)
    .sort((a, b) => b.spendingMinor - a.spendingMinor);
  const targets: FlowItem[] = spending.slice(0, FLOW_CATEGORIES).map((r) => ({
    key: r.key,
    label: r.label,
    color: r.color,
    amountMinor: r.spendingMinor,
    kind: "category",
  }));
  const rest = spending.slice(FLOW_CATEGORIES).reduce((sum, r) => sum + r.spendingMinor, 0);
  if (rest > 0) {
    targets.push({
      key: "other",
      label: "Everything else",
      color: null,
      amountMinor: rest,
      kind: "other",
    });
  }
  const incomeMinor = sources.reduce((sum, s) => sum + s.amountMinor, 0);
  const spendingMinor = spending.reduce((sum, r) => sum + r.spendingMinor, 0);
  if (incomeMinor > spendingMinor) {
    targets.push({
      key: "saved",
      label: "Saved",
      color: null,
      amountMinor: incomeMinor - spendingMinor,
      kind: "saved",
    });
  } else if (spendingMinor > incomeMinor) {
    sources.push({
      key: "shortfall",
      label: "From savings or credit",
      color: null,
      amountMinor: spendingMinor - incomeMinor,
      kind: "shortfall",
    });
  }
  return {
    sources,
    targets,
    incomeMinor,
    spendingMinor,
    totalMinor: Math.max(incomeMinor, spendingMinor),
  };
}

export interface FlowBand extends FlowItem {
  /** Top of the item's bar, and its height, in pixels. */
  y: number;
  height: number;
}

/** Stacks items in a column so bars keep their proportion and every item stays readable. Pure. */
export function stackColumn(
  items: FlowItem[],
  total: number,
  height: number,
  gap: number,
): FlowBand[] {
  const room = Math.max(0, height - gap * Math.max(0, items.length - 1));
  let y = 0;
  return items.map((item) => {
    const size = total > 0 ? (item.amountMinor / total) * room : 0;
    const band = { ...item, y, height: Math.max(1, size) };
    y += band.height + gap;
    return band;
  });
}

/**
 * Label positions as near as possible to where they want to be, at least `gap` apart and inside
 * `0..height`, keeping their order. Pure.
 */
export function spreadLabels(wanted: number[], gap: number, height: number): number[] {
  const half = gap / 2;
  const out = wanted.map((y) => Math.max(half, y));
  for (let i = 1; i < out.length; i += 1) out[i] = Math.max(out[i]!, out[i - 1]! + gap);
  // Pushed past the bottom: pull back up from the end.
  if (out.length > 0) out[out.length - 1] = Math.min(out[out.length - 1]!, height - half);
  for (let i = out.length - 2; i >= 0; i -= 1) out[i] = Math.min(out[i]!, out[i + 1]! - gap);
  return out;
}

// ---- The spending heatmap ------------------------------------------------------------------

export interface HeatDay {
  date: string;
  spendingMinor: number;
  /** 0 for nothing spent, then 1 to 4 by how that day ranks among days with spending. */
  level: number;
  /** After the last day shown: drawn empty so the week stays a full column. */
  future: boolean;
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Days as weeks (Sunday first) ending with `end`, shaded by rank rather than by amount, so one rent
 * payment does not wash out every other day. Pure.
 */
export function heatmapWeeks(
  rows: Array<{ key: string; spendingMinor: number }>,
  end: string,
  weeks: number,
): HeatDay[][] {
  const spent = new Map(rows.map((r) => [r.key, r.spendingMinor]));
  const positive = rows
    .map((r) => r.spendingMinor)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const cut = (q: number): number => positive[Math.floor((positive.length - 1) * q)] ?? 0;
  const [q1, q2, q3] = [cut(0.25), cut(0.5), cut(0.75)];
  const level = (v: number): number => {
    if (v <= 0) return 0;
    if (v <= q1) return 1;
    if (v <= q2) return 2;
    if (v <= q3) return 3;
    return 4;
  };
  const endWeekday = new Date(`${end}T12:00:00Z`).getUTCDay();
  const lastSaturday = addDays(end, 6 - endWeekday);
  const first = addDays(lastSaturday, -(weeks * 7 - 1));
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = addDays(first, w * 7 + d);
      const spendingMinor = Math.max(0, spent.get(date) ?? 0);
      return { date, spendingMinor, level: level(spendingMinor), future: date > end };
    }),
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Average spending for each weekday, Sunday first, counting days with nothing spent too. Pure. */
export function weekdayAverages(weeks: HeatDay[][]): Array<{ day: string; averageMinor: number }> {
  return WEEKDAYS.map((day, i) => {
    const days = weeks.map((w) => w[i]!).filter((d) => !d.future);
    const total = days.reduce((sum, d) => sum + d.spendingMinor, 0);
    return { day, averageMinor: days.length ? Math.round(total / days.length) : 0 };
  });
}

// ---- Merchant trends -----------------------------------------------------------------------

export interface MerchantRow {
  merchant: string;
  totalMinor: number;
  recentAverageMinor: number;
  earlierAverageMinor: number;
}

/** A month's change on average between the earlier and later months. Pure. */
export const merchantChange = (m: MerchantRow): number =>
  m.recentAverageMinor - m.earlierAverageMinor;

/** Biggest first, or fastest growing first. Pure. */
export function sortMerchants<T extends MerchantRow>(list: T[], by: "biggest" | "growing"): T[] {
  return [...list].sort((a, b) =>
    by === "growing" ? merchantChange(b) - merchantChange(a) : b.totalMinor - a.totalMinor,
  );
}
