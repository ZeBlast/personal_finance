import { describe, expect, it } from "vitest";
import { hasMoreThanAYear, returnRows, type PortfolioReturns } from "./ReturnsCard";

const result = {
  startDate: "",
  endDate: "",
  days: 0,
  startValueMinor: 0,
  endValueMinor: 0,
  netContributedMinor: 0,
  gainMinor: 0,
  returnRate: 0.01,
  annualRate: null,
};

function period(key: "ytd" | "year" | "all", label: string, from: string) {
  return { key, label, from, to: "2026-11-03", combined: result, accounts: [] };
}

const fmt = (d: string) => `<${d}>`;

describe("returnRows", () => {
  it("shows one 'Since' row when all three periods start on the same day", () => {
    const periods: PortfolioReturns["periods"] = [
      period("ytd", "This year", "2026-08-01"),
      period("year", "Last 12 months", "2026-08-01"),
      period("all", "Since records began", "2026-08-01"),
    ];
    const rows = returnRows(periods, fmt);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("Since <2026-08-01>");
  });

  it("keeps every row when the start dates differ", () => {
    const periods: PortfolioReturns["periods"] = [
      period("ytd", "This year", "2026-01-01"),
      period("year", "Last 12 months", "2025-11-03"),
      period("all", "Since records began", "2024-05-01"),
    ];
    expect(returnRows(periods, fmt).map((r) => r.label)).toEqual([
      "This year",
      "Last 12 months",
      "Since records began",
    ]);
  });
});

describe("hasMoreThanAYear", () => {
  it("is false for a year or less and true beyond", () => {
    expect(hasMoreThanAYear("2025-11-03", "2026-11-03")).toBe(false);
    expect(hasMoreThanAYear("2025-11-02", "2026-11-03")).toBe(true);
    expect(hasMoreThanAYear("2026-08-01", "2026-11-03")).toBe(false);
  });
});
