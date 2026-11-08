import { describe, expect, it } from "vitest";
import type { SafetyNet } from "../types/planTools";
import { runwayText } from "./planTools";

const net = (over: Partial<SafetyNet>): SafetyNet => ({
  currency: "USD",
  cashMinor: 0,
  reservedMinor: 0,
  freeCashMinor: 0,
  monthlyMinor: 100_000,
  basis: "essential",
  monthsAveraged: 3,
  months: 0,
  essentials: [],
  ...over,
});

describe("runwayText", () => {
  it("is good at or above the target", () => {
    expect(runwayText(net({ months: 7 }), 6)).toMatchObject({ headline: "7 months", tone: "good" });
    expect(runwayText(net({ months: 1 }), 1).headline).toBe("1 month");
  });
  it("warns below the target", () => {
    expect(runwayText(net({ months: 2.5 }), 6)).toMatchObject({
      headline: "2.5 months",
      tone: "warn",
    });
  });
  it("says so when there is no spending yet", () => {
    expect(runwayText(net({ months: null, monthlyMinor: 0 }), 6)).toMatchObject({
      headline: "No spending yet",
      tone: "none",
    });
  });
  it("explains the figure, and nudges toward essentials when all spending counts", () => {
    const essential = runwayText(
      net({ months: 5, monthlyMinor: 100_000, freeCashMinor: 500_000 }),
      6,
    );
    expect(essential.detail).toBe("$1,000.00 a month of essentials, from $5,000.00 after goals.");
    const all = runwayText(net({ months: 5, basis: "all" }), 6);
    expect(all.detail).toMatch(/all spending/);
  });
});
