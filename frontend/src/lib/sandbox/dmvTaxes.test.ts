import { describe, expect, it } from "vitest";
import { bracketTax, formatBrackets, parseBrackets } from "./brackets";
import { MARYLAND_COUNTIES, marylandLocalTax, stateTax, virginiaVehicleTax } from "./dmvTaxes";

describe("state income tax: Maryland, DC, Virginia (2026)", () => {
  it("Virginia: $8,750 deduction and $930 exemption, then 2/3/5/5.75%", () => {
    // 75,000 - 8,750 - 930 = 65,320 taxable.
    const t = stateTax(75_000, "VA", "single", 2026);
    expect(t.taxableIncome).toBe(65_320);
    expect(t.tax).toBeCloseTo(60 + 60 + 600 + (65_320 - 17_000) * 0.0575, 2);
    expect(t.marginalRate).toBe(0.0575);
  });

  it("Maryland: the 2026 brackets, with the new 6.25% and 6.5% at the top", () => {
    const t = stateTax(100_000, "MD", "single", 2026);
    expect(t.taxableIncome).toBe(100_000 - 3_350 - 3_200);
    expect(stateTax(2_000_000, "MD", "single", 2026).marginalRate).toBe(0.065);
    expect(stateTax(700_000, "MD", "married_joint", 2026).marginalRate).toBe(0.0625);
  });

  it("DC: the federal standard deduction and DC's brackets", () => {
    const t = stateTax(100_000, "DC", "single", 2026);
    expect(t.taxableIncome).toBe(83_900);
    expect(t.tax).toBeCloseTo(400 + 1_800 + 1_300 + (83_900 - 60_000) * 0.085, 2);
  });

  it("2027 uses the 2026 figures until new ones are published", () => {
    expect(stateTax(90_000, "MD", "single", 2027)).toEqual(stateTax(90_000, "MD", "single", 2026));
  });

  it("takes the user's own deduction or brackets instead", () => {
    expect(stateTax(50_000, "VA", "single", 2026, { standardDeduction: 0 }).taxableIncome).toBe(
      49_070,
    );
    const own = stateTax(50_000, "VA", "single", 2026, {
      standardDeduction: 0,
      brackets: [[0, 0.1]],
    });
    expect(own.tax).toBe(4_907);
  });
});

describe("Maryland county income tax (2026)", () => {
  it("has all 23 counties and Baltimore City, with the two 2026 increases", () => {
    expect(MARYLAND_COUNTIES).toHaveLength(24);
    expect(MARYLAND_COUNTIES.find((c) => c.id === "allegany")!.rate).toBe(0.032);
    expect(MARYLAND_COUNTIES.find((c) => c.id === "kent")!.rate).toBe(0.033);
  });

  it("applies the county rate to Maryland taxable income", () => {
    const taxable = stateTax(100_000, "MD", "single", 2026).taxableIncome;
    expect(marylandLocalTax(100_000, "montgomery", "single", 2026)!.tax).toBeCloseTo(
      taxable * 0.032,
      1,
    );
    expect(marylandLocalTax(100_000, "worcester", "single", 2026)!.tax).toBeCloseTo(
      taxable * 0.0225,
      1,
    );
  });

  it("uses brackets in Anne Arundel and one tiered rate in Frederick", () => {
    const taxable = stateTax(120_000, "MD", "single", 2026).taxableIncome;
    expect(marylandLocalTax(120_000, "anne_arundel", "single", 2026)!.tax).toBeCloseTo(
      50_000 * 0.027 + (taxable - 50_000) * 0.0294,
      2,
    );
    expect(marylandLocalTax(120_000, "frederick", "single", 2026)!.tax).toBeCloseTo(
      taxable * 0.0296,
      2,
    );
    expect(marylandLocalTax(1, "nowhere", "single", 2026)).toBeNull();
  });
});

describe("Virginia vehicle tax", () => {
  it("matches Fairfax County's own 2026 examples", () => {
    // From the county's page: $10,000 car -> $233.07; $30,000 car -> $923.14.
    const fairfax = { ratePer100: 4.57, reliefPercent: 49, exemptUpTo: 1000 };
    expect(virginiaVehicleTax({ value: 10_000, ...fairfax }).total).toBe(233.07);
    expect(virginiaVehicleTax({ value: 30_000, ...fairfax })).toEqual({
      tax: 923.14,
      relief: 447.86,
      total: 923.14,
    });
    expect(virginiaVehicleTax({ value: 900, ...fairfax }).total).toBe(0);
  });

  it("adds yearly fees", () => {
    expect(
      virginiaVehicleTax({ value: 10_000, ratePer100: 4, reliefPercent: 0, yearlyFees: 40.75 })
        .total,
    ).toBe(440.75);
  });
});

describe("typed brackets", () => {
  it("reads “from percent” pairs in several styles", () => {
    expect(parseBrackets("0 2, 3000 3, 5000 5, 17000 5.75")).toEqual([
      [0, 0.02],
      [3000, 0.03],
      [5000, 0.05],
      [17000, 0.0575],
    ]);
    expect(parseBrackets("$0: 2%\n$3,000: 3%")).toEqual([
      [0, 0.02],
      [3000, 0.03],
    ]);
    expect(parseBrackets("nothing here")).toBeNull();
    expect(formatBrackets([[0, 0.0575]])).toBe("0 5.75");
  });

  it("taxes each slice at its own rate", () => {
    expect(
      bracketTax(15_000, [
        [0, 0.01],
        [10_000, 0.02],
      ]),
    ).toEqual({ tax: 200, marginal: 0.02 });
  });
});
