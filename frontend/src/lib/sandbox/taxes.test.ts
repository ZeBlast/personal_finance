import { describe, expect, it } from "vitest";
import { federalIncomeTax, payrollTax, STANDARD_DEDUCTION } from "./taxes";

describe("federal income tax", () => {
  it("applies the standard deduction and the brackets (2026, single)", () => {
    // $75,000 - $16,100 = $58,900 taxable:
    // 10% of 12,400 + 12% of (50,400 - 12,400) + 22% of (58,900 - 50,400)
    const t = federalIncomeTax(75_000, "single", 2026);
    expect(t.taxableIncome).toBe(58_900);
    expect(t.tax).toBe(round(1_240 + 4_560 + 1_870));
    expect(t.marginalRate).toBe(0.22);
    expect(t.effectiveRate).toBeCloseTo(7_670 / 75_000, 6);
  });

  it("uses the married brackets and deduction", () => {
    const t = federalIncomeTax(120_000, "married_joint", 2026);
    expect(t.deduction).toBe(STANDARD_DEDUCTION[2026].married_joint);
    // 87,800 taxable: 10% of 24,800 + 12% of 63,000
    expect(t.tax).toBe(2_480 + 7_560);
    expect(t.marginalRate).toBe(0.12);
  });

  it("taxes nothing under the deduction, and reaches the top rate", () => {
    expect(federalIncomeTax(10_000, "single", 2026)).toMatchObject({ tax: 0, marginalRate: 0 });
    expect(federalIncomeTax(2_000_000, "single", 2025).marginalRate).toBe(0.37);
    expect(federalIncomeTax(-5, "single", 2025).tax).toBe(0);
  });

  it("takes an itemized deduction instead of the standard one", () => {
    expect(federalIncomeTax(75_000, "single", 2026, 30_000).taxableIncome).toBe(45_000);
  });
});

describe("payroll tax", () => {
  it("is 7.65% up to the Social Security wage base", () => {
    expect(payrollTax(100_000, "single", 2026)).toEqual({
      socialSecurity: 6_200,
      medicare: 1_450,
      total: 7_650,
    });
  });

  it("stops Social Security at the wage base and adds the extra Medicare above $200k", () => {
    const p = payrollTax(300_000, "single", 2026);
    expect(p.socialSecurity).toBe(round(184_500 * 0.062));
    expect(p.medicare).toBe(round(300_000 * 0.0145 + 100_000 * 0.009));
  });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
