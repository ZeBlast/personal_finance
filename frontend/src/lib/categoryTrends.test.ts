import { describe, expect, it } from "vitest";
import { measureValues, niceTicks, rangeFor, stackLayers, summarizeSeries } from "./categoryTrends";

describe("stacking money out and money in", () => {
  it("piles money out up from zero and money in down from it", () => {
    // Two periods: groceries out, fun out, pay in (negative).
    const s = stackLayers(
      [
        [100, 50],
        [30, null],
        [-400, -400],
      ],
      2,
    );
    expect(s.series[0]).toEqual({ lower: [0, 0], upper: [100, 50] });
    expect(s.series[1]).toEqual({ lower: [100, 50], upper: [130, 50] });
    expect(s.series[2]).toEqual({ lower: [0, 0], upper: [-400, -400] });
    expect(s.up).toEqual([130, 50]);
    expect(s.down).toEqual([-400, -400]);
  });
});

const s = {
  key: "1",
  categoryId: 1,
  parentId: null,
  label: "Food",
  color: null,
  values: [1_000, 0, 3_000],
  counts: [2, 0, 3],
  previousTotal: 2_000,
  previousCount: 2,
};
const all = [4_000, 1_000, 6_000];

describe("category explorer figures", () => {
  it("measure amount, count, average, and share, per period and running", () => {
    expect(measureValues(s, "spending", all, false)).toEqual([1_000, 0, 3_000]);
    expect(measureValues(s, "count", all, false)).toEqual([2, 0, 3]);
    expect(measureValues(s, "average", all, false)).toEqual([500, null, 1_000]);
    expect(measureValues(s, "share", all, false)).toEqual([25, 0, 50]);
    expect(measureValues(s, "spending", all, true)).toEqual([1_000, 1_000, 4_000]);
    expect(measureValues(s, "average", all, true)).toEqual([500, 500, 800]);
  });

  it("summarize a series against the period before", () => {
    const buckets = ["Jul", "Aug", "Sep"].map((label, i) => ({
      key: String(i),
      label,
      from: "",
      to: "",
    }));
    expect(summarizeSeries(s, buckets, all)).toEqual({
      total: 4_000,
      count: 5,
      perPeriod: 1_333,
      highest: { label: "Sep", value: 3_000 },
      change: 100,
      share: (4_000 / 11_000) * 100,
    });
  });

  it("turn presets into whole months ending this month", () => {
    const now = new Date(2026, 9, 11);
    expect(rangeFor("3m", now)).toEqual({ from: "2026-08-01", to: "2026-10-11" });
    expect(rangeFor("ytd", now)).toEqual({ from: "2026-01-01", to: "2026-10-11" });
    expect(rangeFor("2y", now)).toEqual({ from: "2024-11-01", to: "2026-10-11" });
  });

  it("make round axis steps from zero", () => {
    expect(niceTicks(0, 9_300)).toEqual([0, 2_000, 4_000, 6_000, 8_000, 10_000]);
    expect(niceTicks(-500, 1_000)[0]).toBeLessThanOrEqual(-500);
  });
});
