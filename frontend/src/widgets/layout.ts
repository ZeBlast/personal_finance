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

/**
 * The dashboard a first-time user gets: every widget that asks for it (`defaultEnabled`), in
 * `order`, packed left to right into rows of 12 columns with no overlaps. Because this is computed
 * from the registry, adding a widget with `defaultEnabled: true` puts it on new dashboards with no
 * other change.
 */
export function buildDefaultLayout(widgets: AnyWidget[]): PlacedWidget[] {
  const chosen = widgets
    .filter((w) => w.defaultEnabled)
    .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id));

  const placed: PlacedWidget[] = [];
  let x = 0;
  let y = 0;
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
