import type { AnyWidget, PlacedWidget } from "./types";

/**
 * The grid is finer than the sizes widgets declare: a widget's `defaultSize` and `minSize` are in
 * the classic 12 columns and 60px rows, and the dashboard works in GRID_SCALE times finer steps
 * (24 columns, 30px rows), so a widget can be resized and placed in half steps.
 */
export const GRID_SCALE = 2;
export const GRID_COLUMNS = 12 * GRID_SCALE;

/** A declared size (12 columns, 60px rows) in grid steps. */
export const toGrid = (size: { w: number; h: number }) => ({
  w: size.w * GRID_SCALE,
  h: size.h * GRID_SCALE,
});

/** A placed size in grid steps, as the size a widget's content is told (declared units). */
export const fromGrid = (size: { w: number; h: number }) => ({
  w: size.w / GRID_SCALE,
  h: size.h / GRID_SCALE,
});

let counter = 0;
/** A key for a widget that has no saved ID yet. */
export function newKey(): string {
  counter += 1;
  return `new-${counter}`;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

interface PlannedWidget extends Rect {
  widgetType: string;
  config?: Record<string, string | number | boolean>;
}

/** Four headline figures, without title bars: each shows its own label. */
const tile = (widgetType: string, x: number, config: PlannedWidget["config"] = {}) => ({
  widgetType,
  x,
  y: 0,
  w: 3,
  h: 2,
  config: { ...config, _hideHeader: true },
});

/**
 * The dashboard a first-time user gets, laid out by hand (12 columns, 60px rows) so every row is
 * full and evenly tall: headline figures first, then net worth, then this month's spending, then
 * what happened and what is coming. Everything else is in "Add widget".
 */
export const DEFAULT_PLAN: readonly PlannedWidget[] = [
  tile("net-worth", 0),
  tile("summary-number", 3, { metric: "spending" }),
  tile("summary-number", 6, { metric: "income" }),
  tile("summary-number", 9, { metric: "net" }),
  { widgetType: "net-worth-history", x: 0, y: 2, w: 8, h: 6 },
  { widgetType: "account-balances", x: 8, y: 2, w: 4, h: 6 },
  { widgetType: "spending-by-category", x: 0, y: 8, w: 6, h: 5 },
  { widgetType: "budget-progress", x: 6, y: 8, w: 6, h: 5 },
  { widgetType: "recent-transactions", x: 0, y: 13, w: 6, h: 6, config: { count: 6 } },
  { widgetType: "recurring-charges", x: 6, y: 13, w: 6, h: 6 },
];

/**
 * The dashboard a first-time user gets: DEFAULT_PLAN (skipping any widget that is not installed),
 * then any other widget that asks for it (`defaultEnabled`), in `order`, packed left to right into
 * rows of 12 columns below it with no overlaps.
 */
export function buildDefaultLayout(widgets: AnyWidget[]): PlacedWidget[] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const placed: PlacedWidget[] = [];
  for (const plan of DEFAULT_PLAN) {
    const widget = byId.get(plan.widgetType);
    if (!widget) continue;
    placed.push({
      key: newKey(),
      widgetType: widget.id,
      enabled: true,
      ...toGrid(plan),
      x: plan.x * GRID_SCALE,
      y: plan.y * GRID_SCALE,
      config: { ...(widget.defaultConfig ?? {}), ...(plan.config ?? {}) },
    });
  }

  const planned = new Set(DEFAULT_PLAN.map((p) => p.widgetType));
  const chosen = widgets
    .filter((w) => w.defaultEnabled && !planned.has(w.id))
    .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id));

  let x = 0;
  let y = nextFreeY(placed);
  let rowHeight = 0;
  for (const widget of chosen) {
    const { w, h } = toGrid(widget.defaultSize);
    if (x + w > GRID_COLUMNS) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    placed.push({
      key: newKey(),
      widgetType: widget.id,
      enabled: true,
      x,
      y,
      w,
      h,
      config: { ...(widget.defaultConfig ?? {}) },
    });
    x += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return placed;
}

/** Where a newly added widget goes: below everything else, at the left. */
export function nextFreeY(widgets: PlacedWidget[]): number {
  return widgets.filter((w) => w.enabled).reduce((bottom, w) => Math.max(bottom, w.y + w.h), 0);
}

/** Puts a widget at the bottom of the dashboard with its default size and settings. */
export function placeNew(widget: AnyWidget, existing: PlacedWidget[]): PlacedWidget {
  return {
    key: newKey(),
    widgetType: widget.id,
    enabled: true,
    x: 0,
    y: nextFreeY(existing),
    ...toGrid(widget.defaultSize),
    config: { ...(widget.defaultConfig ?? {}) },
  };
}
