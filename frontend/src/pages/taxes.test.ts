import { describe, expect, it } from "vitest";
import { estimateTaxes, type SourceInput } from "../lib/taxes/estimate";
import { forEstimate, isPaycheckSource } from "./TaxesPage";

describe("forEstimate", () => {
  const base: SourceInput = {
    key: "income:bank",
    label: "Bank interest",
    kind: "income",
    annualIncome: 10_000,
    suggested: 0,
    ficaExempt: false,
    pretaxRetirement: 5_000,
    pretaxBenefits: 1_000,
    excluded: false,
  };
  const est = (s: SourceInput) =>
    estimateTaxes({
      year: 2026,
      filingStatus: "single",
      state: "none",
      marylandCounty: null,
      customLocalRate: null,
      customLocalName: null,
      federalWithheld: null,
      stateWithheld: null,
      sources: [s],
    });

  it("ignores hidden deductions on a source that is not pay", () => {
    const clean = est({ ...base, pretaxRetirement: 0, pretaxBenefits: 0, ficaExempt: true });
    expect(est(forEstimate(base, false))).toEqual(clean);
    expect(est(base)).not.toEqual(clean);
  });

  it("leaves a paycheck source as it is", () => {
    expect(forEstimate(base, true)).toBe(base);
  });
});

describe("isPaycheckSource", () => {
  it("is true for pay found in the transactions", () => {
    expect(isPaycheckSource({ kind: "income" }, { kind: "income", wages: true })).toBe(true);
  });

  it("is false for interest, dividends, money from people and credits", () => {
    expect(isPaycheckSource({ kind: "income" }, { kind: "income", wages: false })).toBe(false);
    expect(isPaycheckSource({ kind: "credit" }, { kind: "credit", wages: false })).toBe(false);
  });

  it("keeps every field for a source added by hand", () => {
    expect(isPaycheckSource({ kind: "manual" }, undefined)).toBe(true);
  });
});
