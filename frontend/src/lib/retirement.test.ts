import { describe, expect, it } from "vitest";
import {
  inTodaysDollars,
  projectBalances,
  withdrawalPerYear,
  yearlyContributions,
} from "./retirement";

describe("retirement projection", () => {
  it("grows the balance and adds each year's contributions", () => {
    // No contributions: plain compounding.
    expect(
      projectBalances({ balanceMinor: 100_000, yearlyContributionMinor: 0, years: 2, rate: 0.1 }),
    ).toEqual([100_000, 110_000, 121_000]);
    // Contributions grow for half a year on average in the year they go in.
    expect(
      projectBalances({ balanceMinor: 0, yearlyContributionMinor: 10_000, years: 1, rate: 0.1 }),
    ).toEqual([0, 10_500]);
    expect(
      projectBalances({ balanceMinor: 500, yearlyContributionMinor: 0, years: 0, rate: 0.06 }),
    ).toEqual([500]);
  });

  it("counts a year of recurring contributions with the employer's part, not one-time ones", () => {
    const year = yearlyContributions(
      [
        {
          amountMinor: 20_000,
          employerMinor: 20_000,
          frequency: "biweekly",
          active: true,
          endDate: null,
        },
        {
          amountMinor: 50_000,
          employerMinor: 0,
          frequency: "once",
          active: true,
          endDate: "2026-09-15",
        },
        {
          amountMinor: 10_000,
          employerMinor: 0,
          frequency: "monthly",
          active: false,
          endDate: null,
        },
        {
          amountMinor: 10_000,
          employerMinor: 0,
          frequency: "monthly",
          active: true,
          endDate: "2026-01-01",
        },
      ],
      "2026-10-10",
    );
    expect(year).toBe(40_000 * 26);
  });

  it("shows a future amount in today's dollars, and the 4% rule", () => {
    expect(inTodaysDollars(110_250, 2, 0.05)).toBe(100_000);
    expect(withdrawalPerYear(1_000_000_00)).toBe(40_000_00);
  });
});
