import { describe, expect, it } from "vitest";
import { basisText, daysBefore, MAX_DAILY_DAYS, periodLabel, seriesPath } from "./networthSeries";

describe("net worth series request", () => {
  it("asks for the chosen granularity and range", () => {
    expect(seriesPath("week", 90, "2026-10-08")).toBe(
      "/analytics/net-worth-series?granularity=week&from=2026-07-10",
    );
    expect(seriesPath("month", 365, "2026-10-08")).toBe(
      "/analytics/net-worth-series?granularity=month&from=2025-10-08",
    );
  });

  it("caps a daily request, and leaves the start open for everything", () => {
    expect(seriesPath("day", 36500, "2026-10-08")).toBe(
      `/analytics/net-worth-series?granularity=day&from=${daysBefore("2026-10-08", MAX_DAILY_DAYS)}`,
    );
    expect(seriesPath("week", 36500, "2026-10-08")).toBe(
      "/analytics/net-worth-series?granularity=week",
    );
  });

  it("falls back to weeks for a granularity it does not know", () => {
    expect(seriesPath("hour", 30, "2026-10-08")).toContain("granularity=week");
  });
});

describe("describing a point", () => {
  it("says how its accounts were known", () => {
    expect(basisText({ recorded: 2, rebuilt: 1, carried: 0 })).toBe(
      "2 recorded, 1 rebuilt from transactions",
    );
    expect(basisText({ recorded: 0, rebuilt: 0, carried: 3 })).toBe("3 carried forward");
    expect(basisText({ recorded: 0, rebuilt: 0, carried: 0 })).toBe("none");
  });

  it("labels a day, a week, and a month", () => {
    const f = (d: string): string => `<${d}>`;
    const m = (d: string): string => `M${d.slice(0, 7)}`;
    expect(periodLabel("day", { date: "2026-10-08", periodStart: "2026-10-08" }, f, m)).toBe(
      "<2026-10-08>",
    );
    expect(periodLabel("week", { date: "2026-10-11", periodStart: "2026-10-05" }, f, m)).toBe(
      "<2026-10-05> to <2026-10-11>",
    );
    expect(periodLabel("week", { date: "2026-10-05", periodStart: "2026-10-05" }, f, m)).toBe(
      "<2026-10-05>",
    );
    expect(periodLabel("month", { date: "2026-10-31", periodStart: "2026-10-01" }, f, m)).toBe(
      "M2026-10",
    );
  });
});
