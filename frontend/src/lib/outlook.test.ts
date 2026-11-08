import { describe, expect, it } from "vitest";
import type { OutlookInputs } from "../types/planTools";
import { defaultSaving, projectOutlook } from "./outlook";

const inputs = (over: Partial<OutlookInputs>): OutlookInputs => ({
  currency: "USD",
  today: "2026-10-09",
  cashMinor: 0,
  investmentsMinor: 0,
  otherAssetsMinor: 0,
  debtMinor: 0,
  netWorthMinor: 0,
  monthlyIncomeMinor: 0,
  monthlySpendingMinor: 0,
  monthsAveraged: 0,
  debtBalances: [0],
  debtFreeMonths: 0,
  goals: [],
  ...over,
});
const opts = { years: 1, savingPerMonthMinor: 0, rates: [0.05, 0.05, 0.05] as const, multiple: 25 };

describe("projectOutlook", () => {
  it("grows investments by the rate each year", () => {
    const p = projectOutlook(inputs({ investmentsMinor: 100_000 }), opts);
    expect(p.points).toHaveLength(2);
    expect(p.points[0]).toMatchObject({ year: 2026, mid: 100_000 });
    expect(p.points[1]).toMatchObject({ year: 2027, mid: 105_000 });
  });

  it("adds a year of saving", () => {
    const p = projectOutlook(inputs({ investmentsMinor: 100_000 }), {
      ...opts,
      savingPerMonthMinor: 1_000,
      rates: [0, 0, 0],
    });
    expect(p.points[1]!.mid).toBe(112_000);
  });

  it("keeps the three rates apart, low to high", () => {
    const p = projectOutlook(inputs({ investmentsMinor: 100_000 }), {
      ...opts,
      rates: [0.03, 0.05, 0.07],
    });
    expect(p.points[1]).toMatchObject({ low: 103_000, mid: 105_000, high: 107_000 });
  });

  it("takes debt off as the payoff plan pays it down", () => {
    const balances = Array.from({ length: 25 }, (_, m) => Math.max(0, 24_000 - m * 1_000));
    const p = projectOutlook(
      inputs({ cashMinor: 50_000, debtBalances: balances, debtFreeMonths: 24 }),
      { ...opts, years: 3 },
    );
    expect(p.points.map((x) => x.mid)).toEqual([26_000, 38_000, 50_000, 50_000]);
    expect(p.debtFreeYear).toBe(2);
  });

  it("finds when savings reach the work-optional number", () => {
    const p = projectOutlook(
      inputs({ investmentsMinor: 300_000, monthlySpendingMinor: 1_000 }),
      opts,
    );
    expect(p.workOptionalYear).toBe(0);
    const later = projectOutlook(
      inputs({ investmentsMinor: 100_000, monthlySpendingMinor: 1_000 }),
      { ...opts, years: 30 },
    );
    // 100,000 at 5% passes 300,000 in the 23rd year.
    expect(later.workOptionalYear).toBe(23);
  });

  it("has no work-optional year without spending, and no debt-free year when payments never catch up", () => {
    const p = projectOutlook(inputs({ debtFreeMonths: null }), opts);
    expect(p.workOptionalYear).toBeNull();
    expect(p.debtFreeYear).toBeNull();
  });
});

describe("defaultSaving", () => {
  it("is income less spending, never below zero", () => {
    expect(
      defaultSaving(inputs({ monthlyIncomeMinor: 300_000, monthlySpendingMinor: 250_000 })),
    ).toBe(50_000);
    expect(defaultSaving(inputs({ monthlyIncomeMinor: 1, monthlySpendingMinor: 5 }))).toBe(0);
  });
});
