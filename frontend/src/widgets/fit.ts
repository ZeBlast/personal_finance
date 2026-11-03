import { GRID_COLUMNS, LEGACY_DEFAULT_PLAN, overlaps, planToPlaced, type Rect } from "./layout";
import { presetLayout, PRESETS } from "./presets";
import { allWidgets, getWidget } from "./registry";
import type { PlacedWidget } from "./types";

/**
 * Ready-made dashboards fit the window. As long as one is laid out as it was made, it is drawn to suit
 * the window's width and what its widgets hold, without changing what is saved. Once its layout has
 * been changed it is the user's own, and like any other stays exactly where they put things.
 */

/** About how wide a classic column needs to be for a widget's content to stay comfortable, in pixels. */
const COMFORTABLE_COLUMN = 72;
const MIN_ROWS = 2;

const shape = (w: Pick<PlacedWidget, "widgetType" | "x" | "y" | "w" | "h">): string =>
  `${w.widgetType}:${w.x},${w.y},${w.w},${w.h}`;

const sameShape = (a: PlacedWidget[], b: PlacedWidget[]): boolean => {
  if (a.length !== b.length) return false;
  const others = b.map(shape).sort();
  return a
    .map(shape)
    .sort()
    .every((s, i) => s === others[i]);
};

/** Whether a dashboard is still laid out as one of the ready-made ones. Settings do not count. Pure. */
export function isReadyMade(widgets: PlacedWidget[]): boolean {
  if (widgets.length === 0 || widgets.some((w) => !w.enabled)) return false;
  // The Budget dashboard has a bucket per cap, so its plan depends on which caps it was made with.
  const capIds = widgets
    .filter((w) => w.widgetType === "spending-bucket" && w.config["category"])
    .map((w) => Number(w.config["category"]));
  return (
    PRESETS.some((p) => sameShape(widgets, presetLayout(p, capIds, allWidgets()))) ||
    // Everyday as it was made before "This month" was added.
    sameShape(widgets, planToPlaced(LEGACY_DEFAULT_PLAN, allWidgets()))
  );
}

/** How many grid rows a widget needs to show content this tall. Pure. */
export function rowsFor(pixels: number, rowHeight: number, gap: number): number {
  return Math.max(MIN_ROWS, Math.ceil((pixels + gap) / (rowHeight + gap)));
}

/** Widgets whose planned rows overlap, kept together as one band of the page. Pure. */
function bands(widgets: PlacedWidget[]): PlacedWidget[][] {
  const sorted = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: PlacedWidget[][] = [];
  let bottom = -1;
  for (const w of sorted) {
    if (out.length === 0 || w.y >= bottom) out.push([]);
    out[out.length - 1]!.push(w);
    bottom = Math.max(bottom, w.y + w.h);
  }
  return out;
}

/** The width a widget needs in pixels: at least half its plan, and never under its minimum. */
function needs(w: PlacedWidget): number {
  const minimum = getWidget(w.widgetType)?.minSize?.w ?? 2;
  return Math.max(minimum, w.w / 2 / 2) * COMFORTABLE_COLUMN;
}

const pixelsOf = (w: PlacedWidget, width: number, gap: number): number =>
  (width * w.w) / GRID_COLUMNS - gap;

/** Splits widgets into rows that fit, in order, each widget keeping what it needs. Pure. */
function reflow(band: PlacedWidget[], width: number, gap: number): PlacedWidget[][] {
  const rows: PlacedWidget[][] = [];
  let row: PlacedWidget[] = [];
  // A row shares the width in proportion to the plan, so each widget's share must be enough.
  const fits = (candidate: PlacedWidget[]): boolean => {
    const planned = candidate.reduce((sum, w) => sum + w.w, 0);
    return candidate.every((w) => (width * w.w) / planned - gap >= needs(w));
  };
  for (const w of band) {
    if (row.length > 0 && !fits([...row, w])) {
      rows.push(row);
      row = [];
    }
    row.push(w);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

export interface FittedItem extends Rect {
  i: string;
}

/**
 * Where each widget goes for a window this wide. A band that fits keeps its plan's columns. One that
 * does not reflows into rows, each filling the width. Heights follow `rows`, what each widget's
 * content measured, and otherwise its plan, so a band starts where the one above really ends. Pure.
 */
export function fitLayout(
  widgets: PlacedWidget[],
  width: number,
  gap: number,
  rows: Record<string, number>,
): FittedItem[] {
  const out: FittedItem[] = [];
  const height = (w: PlacedWidget): number =>
    getWidget(w.widgetType)?.fixedHeight ? w.h : (rows[w.key] ?? w.h);
  let top = 0;

  for (const band of bands(widgets)) {
    if (band.every((w) => pixelsOf(w, width, gap) >= needs(w))) {
      const placed: FittedItem[] = [];
      for (const w of band) {
        // Stack below anything already placed in these columns.
        const y = placed
          .filter((p) => p.x < w.x + w.w && w.x < p.x + p.w)
          .reduce((lowest, p) => Math.max(lowest, p.y + p.h), top);
        placed.push({ i: w.key, x: w.x, y, w: w.w, h: height(w) });
      }
      // A row of widgets side by side ends level.
      const planTops = new Set(band.map((w) => w.y));
      if (planTops.size === 1) {
        const tallest = Math.max(...placed.map((p) => p.h));
        for (const p of placed) p.h = tallest;
      }
      out.push(...placed);
      top = placed.reduce((lowest, p) => Math.max(lowest, p.y + p.h), top);
      continue;
    }
    for (const row of reflow(band, width, gap)) {
      const planned = row.reduce((sum, w) => sum + w.w, 0);
      const tallest = Math.max(...row.map(height));
      let x = 0;
      row.forEach((w, index) => {
        const share =
          index === row.length - 1 ? GRID_COLUMNS - x : Math.round((w.w / planned) * GRID_COLUMNS);
        out.push({ i: w.key, x, y: top, w: share, h: tallest });
        x += share;
      });
      top += tallest;
    }
  }
  return out;
}

/** Whether no two fitted widgets share a cell, for checking. Pure. */
export const hasNoOverlap = (items: FittedItem[]): boolean =>
  items.every((a, i) => items.slice(i + 1).every((b) => !overlaps(a, b)));
