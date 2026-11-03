import { describe, expect, it } from "vitest";
import { fitLayout, hasNoOverlap, isReadyMade, rowsFor } from "./fit";
import { GRID_COLUMNS, LEGACY_DEFAULT_PLAN, planToPlaced } from "./layout";
import { presetLayout, presetNamed, PRESETS } from "./presets";
import { allWidgets } from "./registry";
import type { PlacedWidget } from "./types";

const GAP = 28;
const made = (name: string, caps: number[] = []): PlacedWidget[] =>
  presetLayout(presetNamed(name)!, caps, allWidgets());

describe("which dashboards fit the window", () => {
  it("is every ready-made one, as made", () => {
    for (const p of PRESETS) expect(isReadyMade(made(p.name)), p.name).toBe(true);
    expect(isReadyMade(made("Budget", [1, 2]))).toBe(true);
    expect(isReadyMade(made("Budget", [1, 2, 3, 4, 5]))).toBe(true);
  });

  it("still fits an untouched Everyday made before This month was added", () => {
    const old = planToPlaced(LEGACY_DEFAULT_PLAN, allWidgets());
    expect(old.some((w) => w.widgetType === "this-month")).toBe(false);
    expect(isReadyMade(old)).toBe(true);
    expect(isReadyMade(made("Everyday"))).toBe(true);
    expect(isReadyMade(old.map((w, i) => (i === 1 ? { ...w, y: w.y + 2 } : w)))).toBe(false);
  });

  it("stops once a widget has been moved or resized, removed, added or hidden", () => {
    const moved = made("Spending").map((w, i) => (i === 1 ? { ...w, y: w.y + 2 } : w));
    expect(isReadyMade(moved)).toBe(false);
    const resized = made("Spending").map((w, i) => (i === 1 ? { ...w, h: w.h + 1 } : w));
    expect(isReadyMade(resized)).toBe(false);
    expect(isReadyMade(made("Spending").slice(1))).toBe(false);
    expect(isReadyMade([...made("Spending"), { ...made("Budget")[0]!, key: "extra" }])).toBe(false);
    expect(isReadyMade(made("Spending").map((w, i) => ({ ...w, enabled: i !== 0 })))).toBe(false);
  });

  it("keeps going when only a widget's settings changed", () => {
    const changed = made("Spending").map((w) => ({
      ...w,
      config: { ...w.config, _title: "Mine", _frame: "always" },
    }));
    expect(isReadyMade(changed)).toBe(true);
  });

  it("does not apply to a layout of the user's own, or an empty one", () => {
    const own = made("Spending").map((w) => ({ ...w, x: 0, y: w.y * 2 }));
    expect(isReadyMade(own)).toBe(false);
    expect(isReadyMade([])).toBe(false);
  });
});

describe("fitting to the window", () => {
  const widths = [644, 700, 860, 1024, 1400, 2200];

  it("never overlaps, and stays inside the grid, at any width", () => {
    for (const p of PRESETS) {
      for (const width of widths) {
        const items = fitLayout(made(p.name, [1, 2]), width, GAP, {});
        expect(hasNoOverlap(items), `${p.name} at ${width}`).toBe(true);
        for (const item of items) {
          expect(item.x + item.w, `${p.name} at ${width}`).toBeLessThanOrEqual(GRID_COLUMNS);
        }
        expect(items).toHaveLength(made(p.name, [1, 2]).length);
      }
    }
  });

  it("keeps the plan's columns when the window is wide enough", () => {
    const widgets = made("Spending");
    const items = fitLayout(widgets, 1400, GAP, {});
    for (const w of widgets) {
      const item = items.find((i) => i.i === w.key)!;
      expect([item.x, item.w]).toEqual([w.x, w.w]);
    }
  });

  it("stacks what no longer fits side by side, filling the width", () => {
    const widgets = made("Everyday");
    const forecast = widgets.find((w) => w.widgetType === "cash-forecast")!;
    const balances = widgets.find((w) => w.widgetType === "account-balances")!;
    const items = fitLayout(widgets, 644, GAP, {});
    const a = items.find((i) => i.i === forecast.key)!;
    const b = items.find((i) => i.i === balances.key)!;
    expect(a.w).toBe(GRID_COLUMNS);
    expect(b.w).toBe(GRID_COLUMNS);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
  });

  it("follows what a widget holds, and lifts what is below it", () => {
    const widgets = made("Budget", [1, 2, 3, 4]);
    const list = widgets.find((w) => w.widgetType === "top-merchants")!;
    const beside = widgets.find((w) => w.widgetType === "recurring-charges")!;
    const planned = fitLayout(widgets, 1400, GAP, {});
    const shorter = fitLayout(widgets, 1400, GAP, { [list.key]: 4, [beside.key]: 4 });
    expect(shorter.find((i) => i.i === list.key)!.h).toBe(4);
    const taller = fitLayout(widgets, 1400, GAP, { [list.key]: 40 });
    expect(taller.find((i) => i.i === list.key)!.h).toBe(40);
    // Side by side, a row ends level.
    expect(taller.find((i) => i.i === beside.key)!.h).toBe(40);
    expect(planned.find((i) => i.i === list.key)!.h).toBe(list.h);
  });

  it("keeps the height of widgets that draw to their slot", () => {
    const widgets = made("Budget", [1]);
    const bucket = widgets.find((w) => w.widgetType === "spending-bucket")!;
    const items = fitLayout(widgets, 1400, GAP, { [bucket.key]: 2 });
    expect(items.find((i) => i.i === bucket.key)!.h).toBeGreaterThanOrEqual(bucket.h);
  });

  it("stacks a side column under itself in the plan's columns", () => {
    const widgets = made("Cash & bills");
    const recurring = widgets.find((w) => w.widgetType === "recurring-charges")!;
    const review = widgets.find((w) => w.widgetType === "review-queue")!;
    const items = fitLayout(widgets, 1400, GAP, { [recurring.key]: 10 });
    const a = items.find((i) => i.i === recurring.key)!;
    const b = items.find((i) => i.i === review.key)!;
    expect(b.y).toBe(a.y + a.h);
    expect(b.x).toBe(a.x);
  });
});

describe("rows for a height", () => {
  it("rounds up to whole rows, with a minimum", () => {
    expect(rowsFor(21, 21, 18)).toBe(2);
    expect(rowsFor(60, 21, 18)).toBe(2);
    expect(rowsFor(61, 21, 18)).toBe(3);
    expect(rowsFor(1, 21, 18)).toBe(2);
  });
});
