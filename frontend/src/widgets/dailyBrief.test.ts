import { describe, expect, it } from "vitest";
import { briefSteps, holdBackNote, missingWarning, type DailyBrief } from "./DailyBriefWidget";

const brief: DailyBrief = {
  currency: "USD",
  today: "2026-10-09",
  cashMinor: 600_000,
  accountsCounted: 1,
  nextIncome: {
    date: "2026-10-20",
    label: "ACME PAYROLL",
    amountMinor: 300_000,
    key: "recurring:acme",
    chosen: false,
  },
  incomeOptions: [],
  incomeChoiceMissing: false,
  missingAccounts: [],
  capHoldBack: { included: false, inWindowMinor: 0 },
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

const usd = (n: number) => `$${(n / 100).toFixed(2)}`;

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

  it("always adds up to what is safe to spend, with or without the lowest-point step", () => {
    const total = (b: DailyBrief) => briefSteps(b).reduce((n, s) => n + s.amountMinor, 0);
    const safe = (b: DailyBrief) => b.lowest.balanceMinor - b.reservedMinor - b.bufferMinor;
    // Cash dips lower than cash less the bills listed (a bill is missing from the list).
    const dips = { ...brief, lowest: { date: "2026-10-12", balanceMinor: 400_000 } };
    expect(briefSteps(dips).map((s) => s.label)).toContainEqual(
      expect.stringMatching(/^Adjusted to the lowest point/),
    );
    expect(total(dips)).toBe(safe(dips));
    // Money arrives before the lowest day, so the lowest is above cash less the bills.
    const income = { ...brief, lowest: { date: "2026-10-12", balanceMinor: 500_000 } };
    expect(total(income)).toBe(safe(income));
    // No adjustment needed: the step is hidden and the lines still add up.
    expect(briefSteps(brief).map((s) => s.label)).not.toContainEqual(
      expect.stringMatching(/^Adjusted/),
    );
    expect(total(brief)).toBe(safe(brief));
  });

  it("shows goal set-asides and the cap hold-back apart from bills", () => {
    const steps = briefSteps({
      ...brief,
      obligations: [
        ...brief.obligations,
        { label: "Trip", date: "2026-10-14", amountMinor: -20_000, source: "goal" },
        { label: "Spending caps", date: "2026-10-13", amountMinor: -5_000, source: "cap_holdback" },
      ],
      obligationsMinor: -175_000,
      lowest: { date: "2026-10-14", balanceMinor: 425_000 },
      safeToSpendMinor: 275_000,
    });
    expect(steps.reduce((n, s) => n + s.amountMinor, 0)).toBe(275_000);
    expect(steps.map((s) => s.label)).toEqual([
      "Cash in the bank now",
      expect.stringMatching(/^Going out by /),
      "Set aside for goals",
      "Held back for spending caps",
      "Held for goals",
      "Buffer you keep",
    ]);
    expect(steps[1]!.note).toBe("City Apartments $1,500.00");
    expect(steps[2]!.amountMinor).toBe(-20_000);
    expect(steps[3]!.amountMinor).toBe(-5_000);
  });
});

describe("what the brief says it leaves out or counts on", () => {
  it("names accounts left out for having no balance", () => {
    expect(missingWarning(brief)).toBeNull();
    expect(missingWarning({ ...brief, missingAccounts: ["Savings"] })).toBe(
      "Savings has no balance yet, so it is not counted.",
    );
  });

  it("says whether the spending caps are held back", () => {
    const on = { ...brief, capHoldBack: { included: true, inWindowMinor: 12_000 } };
    expect(holdBackNote(on, usd)).toBe("Includes $120.00 held back for your spending caps.");
    expect(holdBackNote(brief, usd)).toBe(
      "Spending caps are not held back. You can turn that on in Cash forecast.",
    );
  });
});
