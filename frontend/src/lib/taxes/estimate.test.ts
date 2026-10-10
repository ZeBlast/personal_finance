import { describe, expect, it } from "vitest";
import { stateTax, marylandLocalTax } from "../sandbox/dmvTaxes";
import { federalIncomeTax } from "../sandbox/taxes";
import {
  estimateTaxes,
  projectAnnual,
  suggestAnnual,
  type SourceInput,
  type TaxInputs,
} from "./estimate";

const source = (over: Partial<SourceInput> = {}): SourceInput => ({
  key: "income:acme",
  label: "Acme",
  kind: "income",
  annualIncome: 100_000,
  suggested: 0,
  ficaExempt: false,
  pretaxRetirement: 0,
  pretaxBenefits: 0,
  excluded: false,
  ...over,
});

const inputs = (over: Partial<TaxInputs> = {}): TaxInputs => ({
  year: 2026,
  filingStatus: "single",
  state: "none",
  marylandCounty: null,
  customLocalRate: null,
  customLocalName: null,
  federalWithheld: null,
  stateWithheld: null,
  sources: [source()],
  ...over,
});

describe("estimateTaxes", () => {
  it("adds federal income tax and FICA on wages", () => {
    const e = estimateTaxes(inputs());
    expect(e.federal.tax).toBe(federalIncomeTax(100_000, "single", 2026).tax);
    expect(e.socialSecurity).toBe(6_200);
    expect(e.medicare).toBe(1_450);
    expect(e.stateLines).toEqual([]);
    expect(e.total).toBe(e.federal.tax + 7_650);
  });

  it("takes retirement money off income tax only, and benefits off both", () => {
    const e = estimateTaxes(
      inputs({ sources: [source({ pretaxRetirement: 10_000, pretaxBenefits: 2_000 })] }),
    );
    expect(e.taxableWages).toBe(88_000);
    expect(e.ficaWages).toBe(98_000);
    expect(e.federal.tax).toBe(federalIncomeTax(88_000, "single", 2026).tax);
  });

  it("skips FICA on exempt sources and leaves excluded ones out", () => {
    const e = estimateTaxes(
      inputs({
        sources: [
          source(),
          source({ key: "credit", kind: "credit", annualIncome: 1_000, ficaExempt: true }),
          source({ key: "x", annualIncome: 50_000, excluded: true }),
        ],
      }),
    );
    expect(e.grossIncome).toBe(101_000);
    expect(e.ficaWages).toBe(100_000);
  });

  it("uses the suggestion when no annual income is entered", () => {
    const e = estimateTaxes(
      inputs({ sources: [source({ annualIncome: null, suggested: 40_000 })] }),
    );
    expect(e.grossIncome).toBe(40_000);
  });

  it("adds Maryland state and county tax, and other local tax", () => {
    const e = estimateTaxes(
      inputs({
        state: "MD",
        marylandCounty: "montgomery",
        customLocalRate: 1,
        customLocalName: "City tax",
      }),
    );
    expect(e.stateLines.map((l) => l.label)).toEqual([
      "Maryland income tax",
      "Montgomery County income tax",
      "City tax",
    ]);
    expect(e.stateLines[0]!.amount).toBe(stateTax(100_000, "MD", "single", 2026).tax);
    expect(e.stateLines[1]!.amount).toBe(
      marylandLocalTax(100_000, "montgomery", "single", 2026)!.tax,
    );
    expect(e.stateLines[2]!.amount).toBe(1_000);
  });

  it("shows what is left to pay once withholding is entered", () => {
    const e = estimateTaxes(inputs({ federalWithheld: 20_000 }));
    expect(e.federalBalance).toBeCloseTo(e.federal.tax - 20_000, 2);
    expect(e.stateBalance).toBeNull();
  });
});

describe("projectAnnual", () => {
  it("keeps a finished year's total and scales up the current one", () => {
    expect(projectAnnual(50_000, 2025, new Date(2026, 5, 1))).toBe(50_000);
    // July 1 at the end of the day: 182 of 365 days gone.
    expect(projectAnnual(18_200, 2026, new Date(2026, 6, 1))).toBeCloseTo(36_500, 0);
  });
});

describe("suggestAnnual", () => {
  const today = new Date(2026, 6, 1); // July 1: 182 days of 2026 gone
  it("keeps one-off money and credits as they are", () => {
    expect(
      suggestAnnual(
        { totalMinor: 20_000, count: 1, kind: "income", firstDate: "2026-01-10" },
        2026,
        today,
      ),
    ).toBe(200);
    expect(
      suggestAnnual(
        { totalMinor: 50_000, count: 3, kind: "credit", firstDate: "2026-01-10" },
        2026,
        today,
      ),
    ).toBe(500);
  });

  it("scales repeating pay from its first payment, not from January", () => {
    // Pay since Jan 1: half the year gone, so about double.
    expect(
      suggestAnnual(
        { totalMinor: 1_820_000, count: 13, kind: "income", firstDate: "2026-01-01" },
        2026,
        today,
      ),
    ).toBeCloseTo(36_500, 0);
    // A job that started Apr 1 (91 days in): 92 days paid so far, 275 days in the rest of the year.
    const started = suggestAnnual(
      { totalMinor: 920_000, count: 6, kind: "income", firstDate: "2026-04-01" },
      2026,
      today,
    );
    expect(started).toBeCloseTo((9_200 * 275) / 92, 0);
  });

  it("uses the total for a year that is over", () => {
    expect(
      suggestAnnual(
        { totalMinor: 5_000_000, count: 26, kind: "income", firstDate: "2025-01-03" },
        2025,
        today,
      ),
    ).toBe(50_000);
  });
});
