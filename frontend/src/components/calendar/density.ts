/**
 * How much a calendar day box can show, from the size of one box: everything (`full`), the date,
 * one line of totals and small marks (`compact`), or just the date and the day's net (`tiny`).
 * Like the dashboard's calendar widget, a smaller window shows less instead of cutting it off.
 */
export type CellDensity = "full" | "compact" | "tiny";

/** Below these sizes (pixels, one day box) the box shows less. */
const TINY = { width: 64, height: 64 };
const COMPACT = { width: 120, height: 130 };

/** The density for a month grid `width` × `height` pixels, `weeks` rows of seven days. Pure. */
export function cellDensity(width: number, height: number, weeks: number): CellDensity {
  if (width <= 0 || height <= 0 || weeks <= 0) return "full";
  const w = width / 7;
  const h = height / weeks;
  if (w < TINY.width || h < TINY.height) return "tiny";
  if (w < COMPACT.width || h < COMPACT.height) return "compact";
  return "full";
}
