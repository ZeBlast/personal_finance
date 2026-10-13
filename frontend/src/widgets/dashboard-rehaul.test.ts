import { describe, expect, it } from "vitest";
import { appearanceConfig, readAppearance } from "./appearance";
import { fromGrid, GRID_COLUMNS, toGrid } from "./layout";
import { formatMetric, metricValue } from "./SummaryNumberWidget";

describe("a widget's appearance", () => {
  it("reads a title, a hidden title bar and an accent, ignoring anything invalid", () => {
    expect(
      readAppearance({ _title: "  Groceries  ", _hideHeader: true, _accent: "#16a34a" }),
    ).toEqual({
      title: "Groceries",
      hideHeader: true,
      accent: "#16a34a",
    });
    expect(readAppearance({ _title: 42, _hideHeader: "yes", _accent: "red" })).toEqual({
      title: "",
      hideHeader: false,
      accent: "",
    });
    expect(readAppearance(undefined)).toEqual({ title: "", hideHeader: false, accent: "" });
  });

  it("saves only what differs from the default", () => {
    expect(appearanceConfig({ title: "", hideHeader: false, accent: "" })).toEqual({});
    expect(appearanceConfig({ title: " Bills ", hideHeader: true, accent: "#2563eb" })).toEqual({
      _title: "Bills",
      _hideHeader: true,
      _accent: "#2563eb",
    });
  });
});

describe("the finer dashboard grid", () => {
  it("is twice as fine as the sizes widgets declare", () => {
    expect(GRID_COLUMNS).toBe(24);
    expect(toGrid({ w: 6, h: 4 })).toEqual({ w: 12, h: 8 });
    expect(fromGrid({ w: 13, h: 7 })).toEqual({ w: 6.5, h: 3.5 });
  });
});

describe("the summary number", () => {
  const totals = { spendingMinor: 30_000, incomeMinor: 100_000, netMinor: 70_000, count: 12 };
  it("works out each figure from a period's totals", () => {
    expect(metricValue("spending", totals, 30)).toBe(30_000);
    expect(metricValue("income", totals, 30)).toBe(100_000);
    expect(metricValue("net", totals, 30)).toBe(70_000);
    expect(metricValue("count", totals, 30)).toBe(12);
    expect(metricValue("avg-transaction", totals, 30)).toBe(2_500);
    expect(metricValue("avg-day", totals, 30)).toBe(1_000);
    expect(metricValue("savings-rate", totals, 30)).toBeCloseTo(0.7);
    // No income: no savings rate; no transactions: no average.
    expect(metricValue("savings-rate", { ...totals, incomeMinor: 0 }, 30)).toBeNull();
    expect(metricValue("avg-transaction", { ...totals, count: 0 }, 30)).toBeNull();
  });

  it("formats money, counts and rates", () => {
    expect(formatMetric("spending", 30_000)).toMatch(/300\.00/);
    expect(formatMetric("count", 1_234)).toMatch(/1.?234/);
    expect(formatMetric("savings-rate", 0.7)).toBe("70%");
    expect(formatMetric("savings-rate", null)).toBe("—");
  });
});
