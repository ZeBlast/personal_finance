import { describe, expect, it } from "vitest";
import TemplateWidget from "./TemplateWidget.example";
import { resolveConfig } from "./config";
import { buildDefaultLayout, GRID_COLUMNS, overlaps, placeNew } from "./layout";
import { allWidgets, discoveredWidgets, getWidget, validateWidget } from "./registry";
import { defineWidget, type AnyWidget, type WidgetDefinition } from "./types";

/**
 * This is the safety net for "add a widget by adding a file": it checks EVERY widget found in this
 * folder against the contract, so a new widget with a mistake fails here with a clear message
 * instead of misbehaving on the dashboard.
 */

const noop = () => null;
const valid = (over: Partial<WidgetDefinition> = {}): AnyWidget =>
  defineWidget({
    id: "test-widget",
    title: "Test",
    description: "A test widget.",
    group: "Tools",
    defaultSize: { w: 4, h: 4 },
    Component: noop,
    ...over,
  });

describe("every widget in the folder", () => {
  const found = discoveredWidgets();

  it("finds the built-in widgets", () => {
    expect(found.length).toBeGreaterThanOrEqual(12);
    for (const id of [
      "net-worth",
      "account-balances",
      "credit-cards",
      "spending-summary",
      "spending-by-category",
      "top-merchants",
      "income-vs-spending",
      "cash-flow",
      "budget-progress",
      "recent-transactions",
      "calendar",
      "sync-status",
    ]) {
      expect(getWidget(id), id).toBeDefined();
    }
  });

  it("follows the contract", () => {
    const problems = found.flatMap(({ file, widget }) => validateWidget(widget, file));
    expect(problems).toEqual([]);
  });

  it("has unique IDs, and every discovered widget is registered", () => {
    const ids = found.map(({ widget }) => widget.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      allWidgets()
        .map((w) => w.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it("has settings that survive being checked unchanged (the defaults are valid)", () => {
    for (const { widget } of found) {
      const resolved = resolveConfig(widget, widget.defaultConfig);
      expect(resolved, widget.id).toEqual(widget.defaultConfig ?? {});
    }
  });

  it("copes with damaged saved settings by falling back to defaults", () => {
    for (const { widget } of found) {
      for (const garbage of [
        null,
        undefined,
        "text",
        42,
        [],
        { zzz: 1 },
        Object.fromEntries((widget.configFields ?? []).map((f) => [f.key, { nested: true }])),
      ]) {
        const resolved = resolveConfig(widget, garbage);
        expect(resolved, widget.id).toEqual(widget.defaultConfig ?? {});
      }
    }
  });

  it("builds a default dashboard with no overlaps, inside the grid, from the widgets that ask for it", () => {
    const layout = buildDefaultLayout(allWidgets());
    const expected = allWidgets()
      .filter((w) => w.defaultEnabled)
      .map((w) => w.id)
      .sort();
    expect(layout.map((p) => p.widgetType).sort()).toEqual(expected);
    expect(layout.length).toBeGreaterThanOrEqual(8);
    for (const [i, a] of layout.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(a.x).toBeGreaterThanOrEqual(0);
      for (const b of layout.slice(i + 1))
        expect(overlaps(a, b), `${a.widgetType} vs ${b.widgetType}`).toBe(false);
    }
    expect(new Set(layout.map((p) => p.key)).size).toBe(layout.length);
  });

  it("can place any widget on a dashboard without overlapping what is there", () => {
    const layout = buildDefaultLayout(allWidgets());
    for (const widget of allWidgets()) {
      const added = placeNew(widget, layout);
      for (const existing of layout)
        expect(overlaps(added, existing), `${widget.id} vs ${existing.widgetType}`).toBe(false);
    }
  });
});

describe("the copy-and-edit template", () => {
  it("is itself a valid widget, so the documentation never goes stale", () => {
    expect(validateWidget(TemplateWidget, "TemplateWidget.example.tsx")).toEqual([]);
  });

  it("is not loaded onto the dashboard", () => {
    expect(getWidget(TemplateWidget.id)).toBeUndefined();
  });
});

describe("the contract check catches mistakes", () => {
  const problems = (over: Partial<WidgetDefinition>) => validateWidget(valid(over));

  it("accepts a minimal widget", () => {
    expect(problems({})).toEqual([]);
  });

  it("rejects bad IDs", () => {
    for (const id of ["", "A", "has space", "under_score", "-leading", "x", "a".repeat(60)]) {
      expect(problems({ id }).length, id).toBeGreaterThan(0);
    }
  });

  it("rejects missing text, a bad group, and a missing component", () => {
    expect(problems({ title: " " })).toHaveLength(1);
    expect(problems({ description: "" })).toHaveLength(1);
    expect(problems({ group: "Nonsense" as never })).toHaveLength(1);
    expect(problems({ Component: undefined as never })).toHaveLength(1);
  });

  it("rejects bad sizes", () => {
    expect(problems({ defaultSize: { w: 13, h: 4 } }).length).toBeGreaterThan(0);
    expect(problems({ defaultSize: { w: 0, h: 4 } }).length).toBeGreaterThan(0);
    expect(problems({ defaultSize: { w: 4, h: 1.5 } }).length).toBeGreaterThan(0);
    expect(
      problems({ defaultSize: { w: 4, h: 4 }, minSize: { w: 5, h: 2 } }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects settings that are declared twice or have no default", () => {
    const field = { key: "a", label: "A", type: "boolean" } as const;
    expect(
      problems({ configFields: [field, field], defaultConfig: { a: true } }).some((p) =>
        p.includes("twice"),
      ),
    ).toBe(true);
    expect(
      problems({ configFields: [field], defaultConfig: {} }).some((p) =>
        p.includes("missing a value"),
      ),
    ).toBe(true);
    expect(
      problems({ configFields: [], defaultConfig: { stray: 1 } }).some((p) =>
        p.includes("no setting"),
      ),
    ).toBe(true);
  });

  it("rejects defaults that are not valid for their setting", () => {
    const select = {
      key: "s",
      label: "S",
      type: "select",
      options: [{ value: "a", label: "A" }],
    } as const;
    expect(
      problems({ configFields: [select], defaultConfig: { s: "zzz" } }).some((p) =>
        p.includes("not valid"),
      ),
    ).toBe(true);
    const number = { key: "n", label: "N", type: "number", min: 1, max: 5 } as const;
    expect(
      problems({ configFields: [number], defaultConfig: { n: 99 } }).some((p) =>
        p.includes("not valid"),
      ),
    ).toBe(true);
    expect(
      problems({ configFields: [{ ...number, min: 9, max: 2 }], defaultConfig: { n: 5 } }).some(
        (p) => p.includes("min above max"),
      ),
    ).toBe(true);
  });

  it("rejects selects with no or repeated options, and unlabelled settings", () => {
    expect(
      problems({
        configFields: [{ key: "s", label: "S", type: "select", options: [] }],
        defaultConfig: { s: "" },
      }).some((p) => p.includes("no options")),
    ).toBe(true);
    const dup = {
      key: "s",
      label: "S",
      type: "select",
      options: [
        { value: "a", label: "A" },
        { value: "a", label: "B" },
      ],
    } as const;
    expect(
      problems({ configFields: [dup], defaultConfig: { s: "a" } }).some((p) =>
        p.includes("repeated"),
      ),
    ).toBe(true);
    expect(
      problems({
        configFields: [{ key: "b", label: " ", type: "boolean" }],
        defaultConfig: { b: false },
      }).some((p) => p.includes("no label")),
    ).toBe(true);
  });
});

describe("default dashboard layout", () => {
  it("is empty when no widget asks to be included", () => {
    expect(buildDefaultLayout([valid(), valid({ id: "other-widget" })])).toEqual([]);
  });

  it("packs widgets left to right into rows, ordered by `order`", () => {
    const widgets = [
      valid({ id: "third-widget", defaultEnabled: true, order: 3, defaultSize: { w: 6, h: 2 } }),
      valid({ id: "first-widget", defaultEnabled: true, order: 1, defaultSize: { w: 8, h: 3 } }),
      valid({ id: "second-widget", defaultEnabled: true, order: 2, defaultSize: { w: 4, h: 5 } }),
    ];
    const layout = buildDefaultLayout(widgets);
    expect(layout.map((p) => [p.widgetType, p.x, p.y, p.w, p.h])).toEqual([
      ["first-widget", 0, 0, 8, 3],
      ["second-widget", 8, 0, 4, 5],
      ["third-widget", 0, 5, 6, 2], // the next row starts below the tallest widget of the row above
    ]);
  });

  it("copies default settings so editing one placed widget cannot change another", () => {
    const widgets = [valid({ id: "a-widget", defaultEnabled: true, defaultConfig: { n: 1 } })];
    const first = buildDefaultLayout(widgets);
    const second = buildDefaultLayout(widgets);
    first[0]!.config["n"] = 99;
    expect(second[0]!.config["n"]).toBe(1);
    expect(widgets[0]!.defaultConfig).toEqual({ n: 1 });
  });
});
