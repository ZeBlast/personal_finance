/** Chart arithmetic, kept apart from drawing so it can be tested on its own. */

/** A round number at or above `value` to use as the top of an axis (1, 2, 2.5, 5 times a power of ten). */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/** Evenly spaced tick values from 0 up to `max` (inclusive). */
export function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max * i) / count);
}

export interface Arc {
  /** Fraction of the circle where the slice starts and how much of it it covers (both 0 to 1). */
  start: number;
  fraction: number;
}

/** Slice positions for a donut chart. Zero and negative values are left out. */
export function donutArcs(values: number[]): Arc[] {
  const positive = values.map((v) => (v > 0 ? v : 0));
  const total = positive.reduce((sum, v) => sum + v, 0);
  if (total === 0) return values.map(() => ({ start: 0, fraction: 0 }));
  let start = 0;
  return positive.map((v) => {
    const fraction = v / total;
    const arc = { start, fraction };
    start += fraction;
    return arc;
  });
}

/** Percent of `part` in `whole`, rounded, and 0 when there is no whole. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * A vertical range for a line chart that need not start at zero (a portfolio worth 98,000 to
 * 102,000 would be a flat line on a zero-based axis). Pads the data a little and never goes below 0
 * for non-negative data.
 */
export function paddedRange(min: number, max: number): { low: number; high: number } {
  if (!(Number.isFinite(min) && Number.isFinite(max)) || min > max) return { low: 0, high: 1 };
  const spread = max - min;
  const pad = spread > 0 ? spread * 0.12 : Math.abs(max) * 0.05 || 1;
  const low = min - pad;
  return { low: min >= 0 && low < 0 ? 0 : low, high: max + pad };
}

/** Position of `value` between `low` and `high` as 0 to 1 (0.5 when the range is empty). */
export function fraction(value: number, low: number, high: number): number {
  return high > low ? (value - low) / (high - low) : 0.5;
}

/** Whole days from one `YYYY-MM-DD` day to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** Pairs of neighbouring points, each marked when the stretch between them is a gap (at least `gapDays`). */
export function segmentsOf<T extends { date: string }>(
  points: T[],
  gapDays: number | undefined,
): Array<{ from: T; to: T; gap: boolean }> {
  return points.slice(1).map((to, i) => {
    const from = points[i]!;
    return { from, to, gap: gapDays !== undefined && daysBetween(from.date, to.date) >= gapDays };
  });
}
