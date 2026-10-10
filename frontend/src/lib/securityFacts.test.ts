import { describe, expect, it } from "vitest";
import { securityFacts, taxLotsOf } from "./securityFacts";

const base = {
  symbol: "LFCY50",
  isManual: false,
  plaidSecurityId: "sec-1",
  isin: null,
  optionContractType: null,
  fixedYieldRate: null,
};

const rowsOf = (groups: ReturnType<typeof securityFacts>, title: string) =>
  groups.find((g) => g.title === title)?.rows;

describe("securityFacts", () => {
  it("shows what is known and leaves out what is not", () => {
    const groups = securityFacts({
      ...base,
      isin: "US0000000001",
      sector: "Multi-asset",
      industry: "",
    });
    expect(rowsOf(groups, "Identifiers")).toEqual([
      ["Symbol", "LFCY50"],
      ["ISIN", "US0000000001"],
    ]);
    expect(rowsOf(groups, "Classification")).toEqual([["Sector", "Multi-asset"]]);
    // Nothing is known about options or bonds, so those groups do not appear.
    expect(groups.map((g) => g.title)).toEqual(["Identifiers", "Classification", "Source"]);
  });

  it("shows option and fixed-income details when present", () => {
    const groups = securityFacts({
      ...base,
      optionContractType: "call",
      optionExpiration: "2018-02-01",
      optionStrike: 355,
      optionUnderlying: "NFLX",
      fixedYieldRate: 4.25,
      fixedYieldType: "coupon",
      fixedMaturityDate: "2030-05-15",
      fixedFaceValue: 1000,
    });
    expect(rowsOf(groups, "Option contract")).toEqual([
      ["Contract", "call"],
      ["Expires", "2018-02-01"],
      ["Strike price", expect.stringContaining("355")],
      ["Underlying", "NFLX"],
    ]);
    expect(rowsOf(groups, "Fixed income")?.[0]).toEqual(["Yield", "4.25%"]);
    expect(rowsOf(groups, "Fixed income")).toContainEqual(["Matures", "2030-05-15"]);
  });

  it("keeps a real zero and a real false, which are known values", () => {
    const groups = securityFacts({ ...base, isCashEquivalent: false, closePrice: 0 });
    expect(rowsOf(groups, "Classification")).toContainEqual(["Cash equivalent", "No"]);
    expect(rowsOf(groups, "Pricing")?.[0]?.[0]).toBe("Closing price");
  });

  it("says where the data came from", () => {
    expect(rowsOf(securityFacts(base), "Source")).toEqual([
      ["Where it came from", "Reported by your institution through Plaid"],
      ["Plaid security ID", "sec-1"],
    ]);
    expect(
      rowsOf(securityFacts({ symbol: "TSP-C", isManual: true, plaidSecurityId: null }), "Source"),
    ).toEqual([["Where it came from", "Entered by hand"]]);
  });
});

describe("taxLotsOf", () => {
  it("reads lots from a provider holding", () => {
    expect(
      taxLotsOf({
        tax_lots: [
          {
            institution_lot_id: "L1",
            original_purchase_datetime: "2024-01-02T00:00:00Z",
            quantity: 600,
            purchase_price: 26,
            cost_basis: 15600,
            current_value: 18849.54,
          },
          { quantity: "oops" },
        ],
      }),
    ).toEqual([
      {
        id: "L1",
        purchased: "2024-01-02",
        quantity: 600,
        purchasePrice: 26,
        costBasis: 15600,
        currentValue: 18849.54,
      },
      {
        id: null,
        purchased: null,
        quantity: null,
        purchasePrice: null,
        costBasis: null,
        currentValue: null,
      },
    ]);
  });

  it("returns nothing when there are no lots", () => {
    expect(taxLotsOf(null)).toEqual([]);
    expect(taxLotsOf({})).toEqual([]);
    expect(taxLotsOf({ tax_lots: "nope" })).toEqual([]);
  });
});
