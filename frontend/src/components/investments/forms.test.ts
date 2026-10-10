import { describe, expect, it } from "vitest";
import type { FundPresets, HoldingRow } from "../../types/investments";
import { buildPayload, draftFromHolding, emptyDraft, type HoldingDraft } from "./holdingsForm";
import { buildTransactionPayload, type TransactionDraft } from "./transactionDraft";

const presets: FundPresets = {
  assetClasses: ["Stocks", "Bonds", "Cash", "Funds", "Crypto", "Other"],
  funds: [
    { symbol: "TSP-G", name: "TSP G Fund (Government Securities)", assetClass: "Bonds" },
    { symbol: "TSP-C", name: "TSP C Fund (Common Stock Index)", assetClass: "Stocks" },
  ],
};

const draft = (over: Partial<HoldingDraft>): HoldingDraft => ({
  ...emptyDraft(),
  quantity: "10",
  value: "1000",
  ...over,
});

describe("holdings form", () => {
  it("builds the request for a preset fund with a value", () => {
    const result = buildPayload([draft({ preset: "TSP-C", cost: "800" })], presets);
    expect(result).toEqual({
      ok: true,
      payload: [{ symbol: "TSP-C", quantity: 10, valueMinor: 100000, costBasisMinor: 80000 }],
    });
  });

  it("accepts a price instead of a value, and keeps every decimal of the price", () => {
    const result = buildPayload([draft({ preset: "TSP-G", value: "", price: "17.7512" })], presets);
    expect(result).toEqual({
      ok: true,
      payload: [{ symbol: "TSP-G", quantity: 10, price: 17.7512 }],
    });
  });

  it("sends a custom fund with its name, symbol and class", () => {
    const result = buildPayload(
      [draft({ name: "Employer match fund", symbol: "EMF", assetClass: "Funds" })],
      presets,
    );
    expect(result).toEqual({
      ok: true,
      payload: [
        {
          name: "Employer match fund",
          symbol: "EMF",
          assetClass: "Funds",
          quantity: 10,
          valueMinor: 100000,
        },
      ],
    });
  });

  it("allows a zero value or cost, but never a negative or malformed one", () => {
    expect(
      buildPayload([draft({ preset: "TSP-C", value: "0", cost: "0" })], presets),
    ).toMatchObject({
      ok: true,
    });
    for (const [field, value] of [
      ["value", "-5"],
      ["value", "abc"],
      ["cost", "1.234"],
      ["quantity", "-1"],
      ["quantity", ""],
      ["price", "x"],
    ] as const) {
      const result = buildPayload([draft({ preset: "TSP-C", [field]: value })], presets);
      expect(result.ok, `${field}=${value}`).toBe(false);
    }
  });

  it("says which holding is wrong", () => {
    const result = buildPayload(
      [draft({ preset: "TSP-C" }), draft({ preset: "TSP-G", quantity: "" })],
      presets,
    );
    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/^Holding 2: enter the number of shares/),
    });
  });

  it("needs a fund, and needs a value or a price", () => {
    expect(buildPayload([draft({})], presets)).toEqual({
      ok: false,
      message: expect.stringMatching(/choose a fund/),
    });
    expect(buildPayload([draft({ preset: "TSP-C", value: "" })], presets)).toEqual({
      ok: false,
      message: expect.stringMatching(/total value, or a price/),
    });
  });

  it("fills the form from an existing holding and gives the same holding back", () => {
    const holding: HoldingRow = {
      key: "1:1",
      securityId: 1,
      accountId: 1,
      accountName: "TSP",
      symbol: "TSP-G",
      name: "TSP G Fund (Government Securities)",
      assetClass: "Bonds",
      quantity: 1200.5,
      price: 17.75,
      valueMinor: 2130888,
      costBasisMinor: null,
      gainMinor: null,
      vestedQuantity: null,
      vestedValueMinor: null,
      priceAsOf: null,
      asOf: "2026-09-30",
    };
    const filled = draftFromHolding(holding, presets);
    expect(filled).toMatchObject({
      preset: "TSP-G",
      quantity: "1200.5",
      price: "17.75",
      value: "21308.88",
      cost: "",
    });
    expect(buildPayload([filled], presets)).toEqual({
      ok: true,
      payload: [{ symbol: "TSP-G", quantity: 1200.5, price: 17.75, valueMinor: 2130888 }],
    });
    const custom = draftFromHolding(
      { ...holding, symbol: "EMF", name: "Match", assetClass: "Funds" },
      presets,
    );
    expect(custom).toMatchObject({ preset: "", symbol: "EMF", name: "Match", assetClass: "Funds" });
  });

  it("gives every new row its own key", () => {
    expect(new Set([emptyDraft(), emptyDraft(), emptyDraft()].map((d) => d.key)).size).toBe(3);
  });
});

const tx = (over: Partial<TransactionDraft>): TransactionDraft => ({
  date: "2026-10-01",
  type: "contribution",
  fund: "",
  quantity: "",
  price: "",
  amount: "500",
  fees: "",
  description: "",
  subtype: "",
  datetime: "",
  ...over,
});

describe("transaction form", () => {
  it("builds a simple contribution", () => {
    expect(buildTransactionPayload(tx({}))).toEqual({
      ok: true,
      payload: { date: "2026-10-01", type: "contribution", amountMinor: 50000 },
    });
  });

  it("derives the amount on the server when quantity and price are given", () => {
    expect(
      buildTransactionPayload(
        tx({ type: "buy", amount: "", quantity: "10", price: "98.5", fund: "TSP-C" }),
      ),
    ).toEqual({
      ok: true,
      payload: { date: "2026-10-01", type: "buy", symbol: "TSP-C", quantity: 10, price: 98.5 },
    });
    expect(buildTransactionPayload(tx({ type: "buy", amount: "", quantity: "10" }))).toMatchObject({
      ok: false,
    });
  });

  it("sends names with spaces as a name and ticker-like text as a symbol", () => {
    expect(buildTransactionPayload(tx({ fund: "G Fund" }))).toMatchObject({
      payload: { name: "G Fund" },
    });
    expect(buildTransactionPayload(tx({ fund: "VTI" }))).toMatchObject({
      payload: { symbol: "VTI" },
    });
  });

  it("allows a minus sign only for transfers and other", () => {
    expect(buildTransactionPayload(tx({ type: "transfer", amount: "-75.25" }))).toMatchObject({
      ok: true,
      payload: { amountMinor: -7525 },
    });
    expect(buildTransactionPayload(tx({ type: "buy", amount: "-5" }))).toMatchObject({ ok: false });
  });

  it("rejects bad dates, amounts, quantities and fees", () => {
    for (const over of [
      { date: "" },
      { date: "10/01/2026" },
      { amount: "abc" },
      { amount: "1.234" },
      { quantity: "x", amount: "5" },
      { price: "-1", amount: "5" },
      { fees: "x" },
    ]) {
      expect(buildTransactionPayload(tx(over)).ok, JSON.stringify(over)).toBe(false);
    }
  });

  it("includes fees and a description when given", () => {
    expect(buildTransactionPayload(tx({ fees: "1.50", description: " Rollover " }))).toMatchObject({
      payload: { feesMinor: 150, description: "Rollover" },
    });
  });
});

describe("holding details", () => {
  it("sends vesting, the price date, and identifiers only when given", () => {
    const result = buildPayload(
      [
        draft({
          preset: "TSP-C",
          vestedQuantity: "8",
          vestedValue: "800.50",
          priceAsOf: "2026-09-29",
          isin: " us0000000001 ",
          cusip: "000000001",
          sector: "Large cap",
          industry: "",
        }),
      ],
      presets,
    );
    expect(result).toEqual({
      ok: true,
      payload: [
        {
          symbol: "TSP-C",
          quantity: 10,
          valueMinor: 100000,
          vestedQuantity: 8,
          vestedValueMinor: 80050,
          priceAsOf: "2026-09-29",
          detail: { isin: "US0000000001", cusip: "000000001", sector: "Large cap" },
        },
      ],
    });
  });

  it("refuses vested shares above the shares held, and malformed details", () => {
    for (const over of [
      { vestedQuantity: "11" },
      { vestedQuantity: "abc" },
      { vestedValue: "-5" },
      { vestedValue: "x" },
      { priceAsOf: "29/09/2026" },
    ]) {
      expect(
        buildPayload([draft({ preset: "TSP-C", ...over })], presets).ok,
        JSON.stringify(over),
      ).toBe(false);
    }
  });

  it("keeps a holding's vesting and price date when it is loaded and saved again", () => {
    const holding: HoldingRow = {
      key: "1:1",
      securityId: 1,
      accountId: 1,
      accountName: "TSP",
      symbol: "TSP-C",
      name: "TSP C Fund",
      assetClass: "Stocks",
      quantity: 10,
      price: 100,
      valueMinor: 100000,
      costBasisMinor: null,
      gainMinor: null,
      vestedQuantity: 8,
      vestedValueMinor: 80000,
      priceAsOf: "2026-09-29",
      asOf: "2026-09-30",
    };
    const loaded = draftFromHolding(holding, presets);
    expect(loaded).toMatchObject({
      vestedQuantity: "8",
      vestedValue: "800.00",
      priceAsOf: "2026-09-29",
    });
    expect(buildPayload([loaded], presets)).toMatchObject({
      ok: true,
      payload: [{ vestedQuantity: 8, vestedValueMinor: 80000, priceAsOf: "2026-09-29" }],
    });
  });
});

describe("investment transaction subtype and time", () => {
  it("sends them when given", () => {
    expect(
      buildTransactionPayload(tx({ subtype: " agency match ", datetime: "2026-09-15T14:30" })),
    ).toMatchObject({
      ok: true,
      payload: { subtype: "agency match", datetime: "2026-09-15T14:30" },
    });
  });

  it("leaves them out when empty, and refuses a malformed time", () => {
    const plain = buildTransactionPayload(tx({}));
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.payload).not.toHaveProperty("subtype");
      expect(plain.payload).not.toHaveProperty("datetime");
    }
    for (const datetime of ["yesterday", "2026-09-15 2pm", "15/09/2026"]) {
      expect(buildTransactionPayload(tx({ datetime })).ok, datetime).toBe(false);
    }
  });
});
