import { describe, expect, it } from "vitest";
import { briefSteps, type DailyBrief } from "./DailyBriefWidget";

const brief: DailyBrief = {
  currency: "USD",
  today: "2026-10-09",
  cashMinor: 600_000,
  accountsCounted: 1,
  nextIncome: { date: "2026-10-20", label: "ACME PAYROLL", amountMinor: 300_000 },
  until: "2026-10-19",
  obligations: [
    { label: "City Apartments", date: "2026-10-12", amountMinor: -150_000, source: "recurring" },
  ],
  obligationsMinor: -150_000,
  lowest: { date: "2026-10-12", balanceMinor: 450_000 },
  reservedMinor: 100_000,
  reservedFor: [{ accountName: "Checking", amountMinor: 100_000 }],
  bufferMinor: 50_000,
  safeToSpendMinor: 300_000,
  shortMinor: 0,
  perDayMinor: 27_272,
  spentYesterdayMinor: 0,
  spentThisMonthMinor: 0,
};

describe("how safe-to-spend is worked out", () => {
  it("lists each part, adding up to the answer", () => {
    const steps = briefSteps(brief);
    expect(steps.map((s) => s.label)).toEqual([
      "Cash in the bank now",
      expect.stringMatching(/^Going out by /),
      "Held for goals",
      "Buffer you keep",
    ]);
    expect(steps[1]!.note).toBe("City Apartments $1,500.00");
    expect(steps.reduce((n, s) => n + s.amountMinor, 0)).toBe(brief.safeToSpendMinor);
  });

  it("shows the lowest point when cash dips lower before money comes back", () => {
    const steps = briefSteps({ ...brief, lowest: { date: "2026-10-12", balanceMinor: 400_000 } });
    expect(steps.map((s) => s.label)).toContainEqual(expect.stringMatching(/^Lowest point/));
  });
});
