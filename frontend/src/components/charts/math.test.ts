import { describe, expect, it } from "vitest";
import {
  daysBetween,
  donutArcs,
  fraction,
  niceMax,
  paddedRange,
  percent,
  segmentsOf,
  ticks,
} from "./math";

describe("niceMax", () => {
  it("rounds up to a tidy axis top", () => {
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.1)).toBe(2);
    expect(niceMax(2.3)).toBe(2.5);
    expect(niceMax(4.2)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(2300)).toBe(2500);
    expect(niceMax(98765)).toBe(100000);
    expect(niceMax(250000)).toBe(250000);
  });

  it("never returns less than the value", () => {
    for (const value of [0.01, 0.4, 1, 3, 9.9, 11, 49, 51, 999, 1001, 123456, 8_765_432]) {
      expect(niceMax(value)).toBeGreaterThanOrEqual(value);
    }
  });

  it("gives a usable axis for zero, negative, and invalid values", () => {
    for (const value of [0, -5, Number.NaN]) expect(niceMax(value)).toBe(1);
  });
});

describe("ticks", () => {
  it("spaces ticks evenly from zero to the maximum", () => {
    expect(ticks(100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(ticks(10, 2)).toEqual([0, 5, 10]);
  });
});

describe("donutArcs", () => {
  it("lays slices end to end around the whole circle", () => {
    const arcs = donutArcs([50, 30, 20]);
    expect(arcs.map((a) => a.fraction)).toEqual([0.5, 0.3, 0.2]);
    expect(arcs.map((a) => a.start)).toEqual([0, 0.5, 0.8]);
    expect(arcs.reduce((sum, a) => sum + a.fraction, 0)).toBeCloseTo(1, 10);
  });

  it("ignores zero and negative values and handles no data", () => {
    expect(donutArcs([10, 0, -5, 10]).map((a) => a.fraction)).toEqual([0.5, 0, 0, 0.5]);
    expect(donutArcs([0, 0]).every((a) => a.fraction === 0)).toBe(true);
    expect(donutArcs([])).toEqual([]);
  });
});

describe("percent", () => {
  it("rounds and guards against dividing by zero", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
    expect(percent(5, 0)).toBe(0);
    expect(percent(0, 10)).toBe(0);
    expect(percent(15, 10)).toBe(150);
  });
});

describe("paddedRange", () => {
  it("pads the data so a line is not squeezed against the edges", () => {
    const { low, high } = paddedRange(1000, 2000);
    expect(low).toBeCloseTo(880, 6);
    expect(high).toBeCloseTo(2120, 6);
  });

  it("does not go below zero for non-negative data", () => {
    expect(paddedRange(0, 100).low).toBe(0);
    expect(paddedRange(5, 100).low).toBe(0);
  });

  it("gives a flat series some height, and copes with bad input", () => {
    const flat = paddedRange(500, 500);
    expect(flat.high).toBeGreaterThan(flat.low);
    expect(paddedRange(0, 0)).toEqual({ low: 0, high: 1 });
    expect(paddedRange(Number.NaN, 5)).toEqual({ low: 0, high: 1 });
    expect(paddedRange(9, 3)).toEqual({ low: 0, high: 1 });
  });
});

describe("fraction", () => {
  it("places a value within a range", () => {
    expect(fraction(5, 0, 10)).toBe(0.5);
    expect(fraction(0, 0, 10)).toBe(0);
    expect(fraction(10, 0, 10)).toBe(1);
  });

  it("answers the middle when the range has no width", () => {
    expect(fraction(3, 3, 3)).toBe(0.5);
  });
});

describe("daysBetween", () => {
  it("counts whole days across month, year and leap-day boundaries", () => {
    expect(daysBetween("2026-09-01", "2026-09-01")).toBe(0);
    expect(daysBetween("2026-09-30", "2026-10-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2026-10-05", "2026-09-05")).toBe(-30);
  });
});

describe("segmentsOf", () => {
  const pts = [{ date: "2026-09-01" }, { date: "2026-09-04" }, { date: "2026-09-24" }];

  it("pairs neighbours and marks the long stretches as gaps", () => {
    expect(segmentsOf(pts, 7).map((s) => [s.from.date, s.to.date, s.gap])).toEqual([
      ["2026-09-01", "2026-09-04", false],
      ["2026-09-04", "2026-09-24", true],
    ]);
  });

  it("marks nothing without a threshold, and handles short lists", () => {
    expect(segmentsOf(pts, undefined).every((s) => !s.gap)).toBe(true);
    expect(segmentsOf([], 7)).toEqual([]);
    expect(segmentsOf([pts[0]!], 7)).toEqual([]);
  });

  it("treats exactly the threshold as a gap", () => {
    expect(segmentsOf([{ date: "2026-09-01" }, { date: "2026-09-08" }], 7)[0]!.gap).toBe(true);
    expect(segmentsOf([{ date: "2026-09-01" }, { date: "2026-09-07" }], 7)[0]!.gap).toBe(false);
  });
});
