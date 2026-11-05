import { describe, expect, it } from "vitest";
import { monitorPath, paceText, usualText, type SpendingMonitor } from "./SpendingMonitorWidget";

describe("spending monitor", () => {
  it("asks only for the settings that are filled in", () => {
    expect(monitorPath({ categoryId: "", accountId: "", merchant: "", tag: "" })).toBe(
      "/analytics/monitor",
    );
    expect(monitorPath({ categoryId: "4", accountId: "", merchant: " coffee ", tag: "Trip" })).toBe(
      "/analytics/monitor?category=4&merchant=coffee&tag=Trip",
    );
  });

  it("says how this month compares with usual", () => {
    const m = { changePercent: 200 } as SpendingMonitor;
    expect(paceText(m)).toBe("200% more than usual by this day of the month.");
    expect(paceText({ ...m, changePercent: -25 })).toBe(
      "25% less than usual by this day of the month.",
    );
    expect(paceText({ ...m, changePercent: null })).toMatch(/^Nothing to compare/);
  });

  it("says how many months the usual figure comes from", () => {
    const usd = (n: number) => `$${(n / 100).toFixed(2)}`;
    expect(usualText({ averageMinor: 3_000, baselineMonths: 1 } as SpendingMonitor, usd)).toBe(
      "A whole month is usually $30.00 (from 1 month).",
    );
    expect(usualText({ averageMinor: 3_000, baselineMonths: 3 } as SpendingMonitor, usd)).toBe(
      "A whole month is usually $30.00 (from 3 months).",
    );
    expect(usualText({ averageMinor: 0, baselineMonths: 0 } as SpendingMonitor, usd)).toBe(
      "No full month of history to compare with yet.",
    );
  });
});
