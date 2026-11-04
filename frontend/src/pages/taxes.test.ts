import { describe, expect, it } from "vitest";
import { estimateTaxes, type SourceInput } from "../lib/taxes/estimate";
import { editedSource, forEstimate, isPaycheckSource } from "./TaxesPage";

describe("editedSource", () => {
  const stored = {
    key: "income:bank",
    label: "Bank interest",
    annualIncome: null,
    ficaExempt: false,
    pretaxRetirement: 5_000,
    pretaxBenefits: 1_000,
    excluded: false,
  };
  const shown: SourceInput = {
    ...stored,
    kind: "income",
    suggested: 0,
    ficaExempt: true,
    pretaxRetirement: 0,
    pretaxBenefits: 0,
  };

  it("keeps stored answers hidden from a non-paycheck source when its income is edited", () => {
    expect(editedSource(stored, shown, { annualIncome: 900 })).toEqual({
      ...stored,
      annualIncome: 900,
    });
  });

  it("builds from the shown source when nothing is saved yet", () => {
    expect(editedSource(undefined, shown, { annualIncome: 900 })).toMatchObject({
      annualIncome: 900,
      pretaxRetirement: 0,
      ficaExempt: true,
    });
  });
});

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

  it("keeps the fields for unrecognised pay that has entered answers", () => {
    const none = { pretaxRetirement: 0, pretaxBenefits: 0, ficaExempt: true };
    const found = { kind: "income" as const, wages: false };
    expect(isPaycheckSource({ kind: "income" }, found, none)).toBe(false);
    expect(isPaycheckSource({ kind: "income" }, found, { ...none, pretaxRetirement: 500 })).toBe(
      true,
    );
    expect(isPaycheckSource({ kind: "income" }, found, { ...none, pretaxBenefits: 1 })).toBe(true);
    expect(isPaycheckSource({ kind: "income" }, found, { ...none, ficaExempt: false })).toBe(true);
  });

  it("keeps every field for a source added by hand", () => {
    expect(isPaycheckSource({ kind: "manual" }, undefined)).toBe(true);
  });
});
