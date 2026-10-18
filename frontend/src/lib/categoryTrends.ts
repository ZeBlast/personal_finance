/**
 * The category explorer's figures: what the server sends (spending and transaction counts per
 * category per period), turned into what the user chose to see.
 */

export type Interval = "week" | "month" | "quarter" | "year";
export type Measure = "spending" | "count" | "average" | "share";
export type ChartKind = "line" | "bars" | "stacked" | "area";
export type RangePreset = "3m" | "6m" | "12m" | "ytd" | "2y" | "5y" | "custom";

export interface TrendBucket {
  key: string;
  label: string;
  from: string;
  to: string;
}

export interface TrendSeries {
  key: string;
  categoryId: number | null;
  parentId: number | null;
  label: string;
  color: string | null;
  /** With every transaction: whether the line is the category's money in or out. */
  direction?: "in" | "out";
  values: number[];
  counts: number[];
  previousTotal: number;
  previousCount: number;
}

export interface Trends {
  from: string;
  to: string;
  interval: Interval;
  buckets: TrendBucket[];
  series: TrendSeries[];
  allSpending: number[];
  previous: { from: string; to: string };
}

export const MEASURES: Array<{ id: Measure; label: string }> = [
  { id: "spending", label: "Amount spent" },
  { id: "count", label: "Number of transactions" },
  { id: "average", label: "Average per transaction" },
  { id: "share", label: "Share of all spending" },
];

/**
 * A measure's name for spending (`out`), money coming in (`in`), or every transaction (`all`,
 * money out and in each as their own line). Pure.
 */
export function measureLabel(id: Measure, flow: "out" | "in" | "all"): string {
  if (flow === "in") {
    if (id === "spending") return "Amount in";
    if (id === "share") return "Share of all money in";
  }
  if (flow === "all") {
    if (id === "spending") return "Amount";
    if (id === "share") return "Share of all money moved";
  }
  return MEASURES.find((m) => m.id === id)!.label;
}

export const RANGES: Array<{ id: RangePreset; label: string }> = [
  { id: "3m", label: "3 months" },
  { id: "6m", label: "6 months" },
  { id: "12m", label: "12 months" },
  { id: "ytd", label: "This year" },
  { id: "2y", label: "2 years" },
  { id: "5y", label: "5 years" },
  { id: "custom", label: "Custom" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A preset as dates: whole months, ending with the current one. */
export function rangeFor(
  preset: Exclude<RangePreset, "custom">,
  now = new Date(),
): { from: string; to: string } {
  const to = iso(now);
  if (preset === "ytd") return { from: `${now.getFullYear()}-01-01`, to };
  const months = { "3m": 3, "6m": 6, "12m": 12, "2y": 24, "5y": 60 }[preset];
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  return { from: iso(start), to };
}

/** One series' numbers for the chosen measure, per period (null where it means nothing, such as an average of no transactions). */
export function measureValues(
  s: Pick<TrendSeries, "values" | "counts">,
  measure: Measure,
  allSpending: number[],
  cumulative: boolean,
): Array<number | null> {
  if (cumulative) {
    // Running totals: of money and of transactions; an average and a share are of the totals so far.
    let money = 0;
    let n = 0;
    let all = 0;
    return s.values.map((v, i) => {
      money += v;
      n += s.counts[i]!;
      all += allSpending[i] ?? 0;
      return pick(money, n, all, measure);
    });
  }
  return s.values.map((v, i) => pick(v, s.counts[i]!, allSpending[i] ?? 0, measure));
}

function pick(money: number, n: number, all: number, measure: Measure): number | null {
  switch (measure) {
    case "spending":
      return money;
    case "count":
      return n;
    case "average":
      return n === 0 ? null : Math.round(money / n);
    case "share":
      return all <= 0 ? null : (money / all) * 100;
  }
}

export interface SeriesSummary {
  total: number;
  count: number;
  /** Spending per period, on average over the whole period (periods with none count as zero). */
  perPeriod: number;
  highest: { label: string; value: number } | null;
  /** Change in spending from the period before, as a percentage (null with nothing before). */
  change: number | null;
  share: number | null;
}

export function summarizeSeries(
  s: TrendSeries,
  buckets: TrendBucket[],
  allSpending: number[],
): SeriesSummary {
  const total = s.values.reduce((a, b) => a + b, 0);
  const count = s.counts.reduce((a, b) => a + b, 0);
  const all = allSpending.reduce((a, b) => a + b, 0);
  let highest: SeriesSummary["highest"] = null;
  s.values.forEach((v, i) => {
    if (v > 0 && (!highest || v > highest.value)) highest = { label: buckets[i]!.label, value: v };
  });
  return {
    total,
    count,
    perPeriod: buckets.length === 0 ? 0 : Math.round(total / buckets.length),
    highest,
    change: s.previousTotal > 0 ? ((total - s.previousTotal) / s.previousTotal) * 100 : null,
    share: all > 0 ? (total / all) * 100 : null,
  };
}

/** Rounded "nice" axis steps covering 0..max. */
/**
 * Where each series sits in a stacked chart: values above zero (money out) pile up from zero,
 * values below zero (money in) pile down from it, each in its own pile. `up` and `down` are the
 * piles' totals per period. A missing value (null) adds nothing. Pure.
 */
export function stackLayers(
  series: Array<Array<number | null>>,
  periods: number,
): {
  series: Array<{ lower: number[]; upper: number[] }>;
  up: number[];
  down: number[];
} {
  const up = Array.from({ length: periods }, () => 0);
  const down = Array.from({ length: periods }, () => 0);
  const layers = series.map((values) => {
    const lower: number[] = [];
    const upper: number[] = [];
    for (let i = 0; i < periods; i++) {
      const v = values[i] ?? 0;
      const pile = v < 0 ? down : up;
      lower.push(pile[i]!);
      pile[i]! += v;
      upper.push(pile[i]!);
    }
    return { lower, upper };
  });
  return { series: layers, up, down };
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [0];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step)
    ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks[ticks.length - 1]! < hi) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}
