import { describe, expect, it } from "vitest";
import { monitorPath, paceText, type SpendingMonitor } from "./SpendingMonitorWidget";

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
});
