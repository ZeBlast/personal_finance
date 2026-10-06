import { describe, expect, it } from "vitest";
import { summaryPath } from "./analytics";
import {
  firstOfMonth,
  lastOfMonth,
  monthLabel,
  recentMonths,
  resolvePeriod,
  shiftMonth,
  toDay,
} from "./period";

/** A local date at noon, so no time zone can move it to another day. */
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

describe("month arithmetic", () => {
  it("moves across year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-03", -14)).toBe("2025-01");
    expect(shiftMonth("2026-06", 0)).toBe("2026-06");
  });

  it("finds the first and last day, including leap years", () => {
    expect(firstOfMonth("2026-09")).toBe("2026-09-01");
    expect(lastOfMonth("2026-09")).toBe("2026-09-30");
    expect(lastOfMonth("2026-12")).toBe("2026-12-31");
    expect(lastOfMonth("2026-02")).toBe("2026-02-28");
    expect(lastOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastOfMonth("2100-02")).toBe("2100-02-28"); // not a leap year
  });

  it("formats a local date without time-zone shifts", () => {
    expect(toDay(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
    expect(toDay(new Date(2026, 11, 31, 23, 55))).toBe("2026-12-31");
  });

  it("labels months", () => {
    expect(monthLabel("2026-09", "long")).toContain("2026");
    expect(monthLabel("2026-09")).toMatch(/Sep/);
  });
});

describe("resolvePeriod", () => {
  it("this month runs from the 1st to today, compared with the same days of last month", () => {
    const p = resolvePeriod("this-month", at(2026, 10, 5));
    expect(p).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-05",
      previous: { from: "2026-09-01", to: "2026-09-05" },
    });
  });

  it("caps the comparison day when last month is shorter", () => {
    expect(resolvePeriod("this-month", at(2026, 3, 31)).previous).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(resolvePeriod("this-month", at(2028, 3, 31)).previous).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(resolvePeriod("this-month", at(2026, 5, 31)).previous).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
  });

  it("handles January, comparing with December of the year before", () => {
    const p = resolvePeriod("this-month", at(2026, 1, 15));
    expect(p).toMatchObject({
      from: "2026-01-01",
      to: "2026-01-15",
      previous: { from: "2025-12-01", to: "2025-12-15" },
    });
  });

  it("last month is the whole previous month, compared with the month before", () => {
    expect(resolvePeriod("last-month", at(2026, 10, 5))).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
      previous: { from: "2026-08-01", to: "2026-08-31" },
    });
    expect(resolvePeriod("last-month", at(2026, 1, 20))).toMatchObject({
      from: "2025-12-01",
      to: "2025-12-31",
      previous: { from: "2025-11-01", to: "2025-11-30" },
    });
    expect(resolvePeriod("last-month", at(2028, 3, 3))).toMatchObject({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("rolling periods include today and are compared with the same number of days before", () => {
    const p30 = resolvePeriod("last-30-days", at(2026, 10, 5));
    expect(p30).toMatchObject({
      from: "2026-09-06",
      to: "2026-10-05",
      previous: { from: "2026-08-07", to: "2026-09-05" },
    });
    const p90 = resolvePeriod("last-90-days", at(2026, 10, 5));
    expect(p90).toMatchObject({ from: "2026-07-08", to: "2026-10-05" });
    // Both are exactly the requested length.
    const days = (a: string, b: string) =>
      Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
    expect(days(p30.from, p30.to)).toBe(30);
    expect(days(p30.previous.from, p30.previous.to)).toBe(30);
    expect(days(p90.previous.from, p90.previous.to)).toBe(90);
  });

  it("this year runs from January 1, compared with the same point last year", () => {
    expect(resolvePeriod("this-year", at(2026, 10, 5))).toMatchObject({
      from: "2026-01-01",
      to: "2026-10-05",
      previous: { from: "2025-01-01", to: "2025-10-05" },
    });
    expect(resolvePeriod("this-year", at(2028, 2, 29)).previous).toEqual({
      from: "2027-01-01",
      to: "2027-02-28",
    }); // no Feb 29 last year
  });

  it("last 12 months starts on the 1st, eleven months back", () => {
    const p = resolvePeriod("last-12-months", at(2026, 10, 5));
    expect(p).toMatchObject({ from: "2025-11-01", to: "2026-10-05" });
    expect(p.previous.to).toBe("2025-10-31");
    expect(p.previous.from).toBe("2024-11-01");
  });

  it("treats an unknown preset as this month rather than failing", () => {
    expect(resolvePeriod("whatever", at(2026, 10, 5)).from).toBe("2026-10-01");
  });

  it("recentMonths covers whole months back to the first of the earliest", () => {
    expect(recentMonths(1, at(2026, 10, 5))).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(recentMonths(6, at(2026, 10, 5))).toEqual({ from: "2026-05-01", to: "2026-10-05" });
    expect(recentMonths(12, at(2026, 2, 10))).toEqual({ from: "2025-03-01", to: "2026-02-10" });
  });
});

describe("summaryPath", () => {
  it("builds a minimal query and leaves out anything unset", () => {
    expect(summaryPath({ from: "2026-09-01", to: "2026-09-30" })).toBe(
      "/analytics/summary?from=2026-09-01&to=2026-09-30",
    );
    expect(
      summaryPath({ from: "a", to: "b", accountId: "", category: "", includePending: true }),
    ).toBe("/analytics/summary?from=a&to=b");
  });

  it("includes every option that is set", () => {
    const path = summaryPath({
      from: "2026-09-01",
      to: "2026-09-30",
      groupBy: "category",
      accountId: "3",
      category: "none",
      rollupToParent: true,
      includeTransfers: true,
      includePending: false,
      limit: 5,
      fill: true,
    });
    const query = new URLSearchParams(path.split("?")[1]);
    expect(Object.fromEntries(query)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      groupBy: "category",
      accountId: "3",
      category: "none",
      rollupToParent: "1",
      includeTransfers: "1",
      includePending: "0",
      limit: "5",
      fill: "1",
    });
  });
});
