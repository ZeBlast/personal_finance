import { afterEach, describe, expect, it } from "vitest";
import { accounts, plaidItems } from "../../drizzle/schema.js";
import { RealPlaidGateway } from "./plaid/real-gateway.js";
import {
  applyHoldingsSnapshot,
  applyInvestmentTransactions,
} from "./services/investment.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}
type T = ReturnType<typeof app>;

// ---------------------------------------------------------------------------------------------
// What Plaid sends (snake_case), including everything an investment account can carry.
// ---------------------------------------------------------------------------------------------

const PLAID_SECURITIES = [
  {
    security_id: "sec-fund",
    isin: "US0000000001",
    cusip: "000000001",
    sedol: "B000001",
    institution_security_id: "INST-1",
    institution_id: "ins_x",
    proxy_security_id: null,
    name: "Lifecycle 2050 Fund",
    ticker_symbol: "LFCY50",
    is_cash_equivalent: false,
    type: "mutual fund",
    subtype: "target date",
    close_price: 31.4159,
    close_price_as_of: "2026-09-29",
    update_datetime: "2026-09-29T21:00:00Z",
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    market_identifier_code: "XNAS",
    sector: "Multi-asset",
    industry: "Target date",
    cfi_code: "CIOGEU",
    figi: "BBG000000001",
    option_contract: null,
    fixed_income: null,
  },
  {
    security_id: "sec-option",
    name: "Nflx Feb 01'18 $355 Call",
    ticker_symbol: "NFLX180201C00355000",
    type: "derivative",
    subtype: "option",
    is_cash_equivalent: false,
    close_price: 1.1,
    close_price_as_of: null,
    iso_currency_code: "USD",
    option_contract: {
      contract_type: "call",
      expiration_date: "2018-02-01",
      strike_price: 355,
      underlying_security_ticker: "NFLX",
    },
    fixed_income: null,
  },
  {
    security_id: "sec-bond",
    name: "US Treasury Note",
    ticker_symbol: null,
    type: "fixed income",
    subtype: "bond",
    is_cash_equivalent: false,
    iso_currency_code: "USD",
    option_contract: null,
    fixed_income: {
      yield_rate: { percentage: 4.25, type: "coupon" },
      maturity_date: "2030-05-15",
      issue_date: "2020-05-15",
      face_value: 1000,
    },
  },
];

const PLAID_HOLDINGS = [
  {
    account_id: "acct-tsp",
    security_id: "sec-fund",
    institution_price: 31.4159,
    institution_price_as_of: "2026-09-29",
    institution_price_datetime: "2026-09-29T21:00:00Z",
    institution_value: 31415.9,
    cost_basis: 28000,
    quantity: 1000,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    vested_quantity: 800,
    vested_value: 25132.72,
    tax_lots: [
      {
        institution_lot_id: "L1",
        original_purchase_datetime: "2024-01-02T00:00:00Z",
        quantity: 600,
        purchase_price: 26,
        cost_basis: 15600,
        current_value: 18849.54,
      },
      {
        institution_lot_id: "L2",
        original_purchase_datetime: "2025-03-04T00:00:00Z",
        quantity: 400,
        purchase_price: 31,
        cost_basis: 12400,
        current_value: 12566.36,
      },
    ],
  },
  {
    account_id: "acct-tsp",
    security_id: "sec-option",
    institution_price: 1.1,
    institution_value: 1100,
    cost_basis: null,
    quantity: 10,
    iso_currency_code: "USD",
  },
  {
    account_id: "acct-tsp",
    security_id: "sec-bond",
    institution_price: 99.5,
    institution_value: 995,
    cost_basis: 1000,
    quantity: 10,
    iso_currency_code: "USD",
  },
];

const PLAID_TRANSACTIONS = [
  {
    investment_transaction_id: "itx-1",
    cancel_transaction_id: null,
    account_id: "acct-tsp",
    security_id: "sec-fund",
    date: "2026-09-15",
    transaction_datetime: "2026-09-15T14:30:00Z",
    name: "Agency matching contribution",
    quantity: 19.1,
    amount: -600,
    price: 31.4,
    fees: null,
    type: "cash",
    subtype: "contribution",
    iso_currency_code: "USD",
  },
  {
    investment_transaction_id: "itx-2",
    cancel_transaction_id: null,
    account_id: "acct-tsp",
    security_id: "sec-fund",
    date: "2026-09-20",
    name: "Buy Lifecycle 2050 Fund",
    quantity: 10,
    amount: 314,
    price: 31.4,
    fees: 1.5,
    type: "buy",
    subtype: "buy",
    iso_currency_code: "USD",
  },
];

/** A stand-in for Plaid's API that answers with the objects above. */
function plaidApi(transactions: unknown[] = PLAID_TRANSACTIONS) {
  return {
    investmentsHoldingsGet: async () => ({
      data: { holdings: PLAID_HOLDINGS, securities: PLAID_SECURITIES },
    }),
    investmentsTransactionsGet: async () => ({
      data: {
        investment_transactions: transactions,
        securities: PLAID_SECURITIES,
        total_investment_transactions: transactions.length,
      },
    }),
  };
}

/** A connection with an investment account whose Plaid ID is `acct-tsp`, visible in the demo environment. */
function connection(t: T) {
  const now = "2026-10-01T00:00:00Z";
  const item = t.db
    .insert(plaidItems)
    .values({
      plaidItemId: "item-1",
      environment: "fake",
      institutionName: "A Retirement Plan",
      accessTokenEncrypted: "x",
      daysRequested: 730,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: plaidItems.id })
    .get();
  const account = t.db
    .insert(accounts)
    .values({
      plaidItemId: item.id,
      plaidAccountId: "acct-tsp",
      name: "Plan account",
      type: "investment",
      subtype: "401k",
      currency: "USD",
      currentBalanceMinor: 3351159,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: accounts.id })
    .get();
  return { itemId: item.id, accountId: account.id };
}

async function loadFromPlaid(t: T, transactions?: unknown[]) {
  const gateway = new RealPlaidGateway("sandbox", plaidApi(transactions) as never);
  const { itemId, accountId } = connection(t);
  const holdings = await gateway.getInvestmentHoldings("token");
  const activity = await gateway.getInvestmentTransactions("token", "2024-01-01", "2026-10-01");
  return { gateway, holdings, activity, itemId, accountId };
}

describe("everything Plaid provides for an investment account", () => {
  it("is read in full from Plaid's objects", async () => {
    const gateway = new RealPlaidGateway("sandbox", plaidApi() as never);
    const { holdings, securities } = await gateway.getInvestmentHoldings("token");
    const fund = securities.find((s) => s.securityId === "sec-fund")!;
    expect(fund).toMatchObject({
      symbol: "LFCY50",
      name: "Lifecycle 2050 Fund",
      type: "mutual fund",
      subtype: "target date",
      isin: "US0000000001",
      cusip: "000000001",
      sedol: "B000001",
      figi: "BBG000000001",
      cfiCode: "CIOGEU",
      institutionSecurityId: "INST-1",
      marketIdentifierCode: "XNAS",
      isCashEquivalent: false,
      closePrice: 31.4159,
      closePriceAsOf: "2026-09-29",
      sector: "Multi-asset",
      industry: "Target date",
      updatedAt: "2026-09-29T21:00:00Z",
    });
    expect(securities.find((s) => s.securityId === "sec-option")!.option).toEqual({
      contractType: "call",
      expiration: "2018-02-01",
      strike: 355,
      underlying: "NFLX",
    });
    expect(securities.find((s) => s.securityId === "sec-bond")!.fixedIncome).toEqual({
      yieldRate: 4.25,
      yieldType: "coupon",
      maturityDate: "2030-05-15",
      issueDate: "2020-05-15",
      faceValue: 1000,
    });
    expect(holdings[0]).toMatchObject({
      vestedQuantity: 800,
      vestedValue: 25132.72,
      priceAsOf: "2026-09-29",
      priceDatetime: "2026-09-29T21:00:00Z",
    });
    // The whole object is kept, tax lots and all.
    expect((holdings[0]!.raw as { tax_lots: unknown[] }).tax_lots).toHaveLength(2);
    const { transactions } = await gateway.getInvestmentTransactions(
      "token",
      "2024-01-01",
      "2026-10-01",
    );
    expect(transactions[0]).toMatchObject({
      kind: "contribution",
      subtype: "contribution",
      datetime: "2026-09-15T14:30:00Z",
    });
  });

  it("is stored in full, with the provider's own record alongside", async () => {
    const t = app();
    const { holdings, itemId, accountId } = await loadFromPlaid(t);
    applyHoldingsSnapshot(t.db, itemId, holdings as never, "2026-10-01T00:00:00Z");
    const rows = (
      await t.call("get", `/api/investments/holdings?accountId=${accountId}`).expect(200)
    ).body;
    expect(rows).toHaveLength(3);
    const fund = rows.find((r: { symbol: string }) => r.symbol === "LFCY50");
    expect(fund).toMatchObject({
      quantity: 1000,
      valueMinor: 3141590,
      costBasisMinor: 2800000,
      vestedQuantity: 800,
      vestedValueMinor: 2513272,
    });

    const detail = (
      await t.call("get", `/api/investments/securities/${fund.securityId}`).expect(200)
    ).body;
    expect(detail.security).toMatchObject({
      symbol: "LFCY50",
      isin: "US0000000001",
      cusip: "000000001",
      sedol: "B000001",
      figi: "BBG000000001",
      sector: "Multi-asset",
      industry: "Target date",
      subtype: "target date",
      closePrice: 31.4159,
      closePriceAsOf: "2026-09-29",
      isCashEquivalent: false,
      plaidSecurityId: "sec-fund",
      isManual: false,
    });
    expect(detail.security).not.toHaveProperty("rawJson");
    expect(detail.raw).toMatchObject({
      security_id: "sec-fund",
      isin: "US0000000001",
      cfi_code: "CIOGEU",
    });
    expect(detail.positions).toEqual([
      expect.objectContaining({
        accountName: "Plan account",
        quantity: 1000,
        vestedQuantity: 800,
        vestedValueMinor: 2513272,
        priceAsOf: "2026-09-29",
        priceDatetime: "2026-09-29T21:00:00Z",
      }),
    ]);
    // The tax lots Plaid sent are available.
    expect(
      detail.positions[0].raw.tax_lots.map(
        (l: { institution_lot_id: string }) => l.institution_lot_id,
      ),
    ).toEqual(["L1", "L2"]);
  });

  it("keeps option and fixed-income details", async () => {
    const t = app();
    const { holdings, itemId, accountId } = await loadFromPlaid(t);
    applyHoldingsSnapshot(t.db, itemId, holdings as never, "2026-10-01T00:00:00Z");
    const rows = (
      await t.call("get", `/api/investments/holdings?accountId=${accountId}`).expect(200)
    ).body;
    const option = (
      await t
        .call(
          "get",
          `/api/investments/securities/${rows.find((r: { name: string }) => r.name.startsWith("Nflx")).securityId}`,
        )
        .expect(200)
    ).body.security;
    expect(option).toMatchObject({
      optionContractType: "call",
      optionExpiration: "2018-02-01",
      optionStrike: 355,
      optionUnderlying: "NFLX",
    });
    const bond = (
      await t
        .call(
          "get",
          `/api/investments/securities/${rows.find((r: { name: string }) => r.name === "US Treasury Note").securityId}`,
        )
        .expect(200)
    ).body.security;
    expect(bond).toMatchObject({
      fixedYieldRate: 4.25,
      fixedYieldType: "coupon",
      fixedMaturityDate: "2030-05-15",
      fixedIssueDate: "2020-05-15",
      fixedFaceValue: 1000,
    });
  });

  it("updates in place on every sync without duplicating", async () => {
    const t = app();
    const { holdings, itemId } = await loadFromPlaid(t);
    for (let i = 0; i < 3; i += 1)
      applyHoldingsSnapshot(t.db, itemId, holdings as never, `2026-10-0${i + 1}T00:00:00Z`);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM securities").get()).toEqual({ n: 3 });
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM holdings").get()).toEqual({ n: 3 });
  });

  it("stores investment transactions with their subtype and time, and the original record", async () => {
    const t = app();
    const { activity, itemId, accountId } = await loadFromPlaid(t);
    applyInvestmentTransactions(t.db, itemId, activity, "2026-10-01T00:00:00Z");
    const list = (
      await t.call("get", `/api/investments/transactions?accountId=${accountId}`).expect(200)
    ).body.rows;
    expect(list).toHaveLength(2);
    const match = list.find((r: { name: string }) => r.name === "Agency matching contribution");
    expect(match).toMatchObject({
      type: "contribution",
      subtype: "contribution",
      transactionDatetime: "2026-09-15T14:30:00Z",
      amountMinor: -60000,
    });
    const detail = (await t.call("get", `/api/investments/transactions/${match.id}`).expect(200))
      .body;
    expect(detail.raw).toMatchObject({
      investment_transaction_id: "itx-1",
      subtype: "contribution",
    });
    await t.call("get", "/api/investments/transactions/99999").expect(404);
    await t.call("get", "/api/investments/securities/99999").expect(404);
  });

  it("drops a transaction and its cancellation, so the history shows what really happened", async () => {
    const t = app();
    const { gateway, itemId, accountId } = await loadFromPlaid(t);
    applyInvestmentTransactions(
      t.db,
      itemId,
      await gateway.getInvestmentTransactions("t", "a", "b"),
      "2026-10-01T00:00:00Z",
    );
    expect(
      (await t.call("get", `/api/investments/transactions?accountId=${accountId}`).expect(200)).body
        .total,
    ).toBe(2);
    // Later, Plaid reports that the purchase was cancelled.
    const cancelled = [
      ...PLAID_TRANSACTIONS,
      {
        ...PLAID_TRANSACTIONS[1],
        investment_transaction_id: "itx-3",
        cancel_transaction_id: "itx-2",
        type: "cancel",
        subtype: "cancel",
        amount: -314,
      },
    ];
    const next = await new RealPlaidGateway(
      "sandbox",
      plaidApi(cancelled) as never,
    ).getInvestmentTransactions("t", "a", "b");
    applyInvestmentTransactions(t.db, itemId, next, "2026-10-02T00:00:00Z");
    const list = (
      await t.call("get", `/api/investments/transactions?accountId=${accountId}`).expect(200)
    ).body.rows;
    expect(list.map((r: { name: string }) => r.name)).toEqual(["Agency matching contribution"]);
    // Running it again changes nothing.
    applyInvestmentTransactions(t.db, itemId, next, "2026-10-03T00:00:00Z");
    expect(
      (await t.call("get", `/api/investments/transactions?accountId=${accountId}`).expect(200)).body
        .total,
    ).toBe(1);
  });
});

describe("the same data for an account kept by hand (the Thrift Savings Plan)", () => {
  async function tsp(t: T) {
    return (
      await t
        .call("post", "/api/investments/accounts")
        .send({ name: "TSP", officialName: "Thrift Savings Plan" })
        .expect(201)
    ).body.id as number;
  }

  it("stores vesting, identifiers, and the price date", async () => {
    const t = app();
    const id = await tsp(t);
    await t
      .call("put", `/api/investments/accounts/${id}/holdings`)
      .send({
        holdings: [
          {
            symbol: "TSP-L2050",
            quantity: 1000,
            price: 31.4159,
            costBasisMinor: 2800000,
            vestedQuantity: 800,
            vestedValueMinor: 2513272,
            priceAsOf: "2026-09-29",
            asOf: "2026-09-30",
            detail: {
              isin: "US0000000001",
              cusip: "000000001",
              sector: "Multi-asset",
              industry: "Target date",
              subtype: "target date",
              closePrice: 31.4159,
              closePriceAsOf: "2026-09-29",
            },
          },
        ],
      })
      .expect(200);
    const row = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body[0];
    expect(row).toMatchObject({
      symbol: "TSP-L2050",
      name: "TSP L 2050 Fund",
      vestedQuantity: 800,
      vestedValueMinor: 2513272,
      valueMinor: 3141590,
    });
    const detail = (
      await t.call("get", `/api/investments/securities/${row.securityId}`).expect(200)
    ).body;
    expect(detail.security).toMatchObject({
      isManual: true,
      isin: "US0000000001",
      cusip: "000000001",
      sector: "Multi-asset",
      industry: "Target date",
      subtype: "target date",
      closePrice: 31.4159,
    });
    expect(detail.raw).toBeNull(); // nothing came from a provider
    expect(detail.positions[0]).toMatchObject({
      vestedQuantity: 800,
      priceAsOf: "2026-09-29",
      asOf: "2026-09-30",
    });
  });

  it("keeps the details when the holdings are saved again without them", async () => {
    const t = app();
    const id = await tsp(t);
    const put = (holding: Record<string, unknown>) =>
      t
        .call("put", `/api/investments/accounts/${id}/holdings`)
        .send({ holdings: [holding] })
        .expect(200);
    await put({
      symbol: "TSP-C",
      quantity: 10,
      valueMinor: 100000,
      detail: { isin: "US1111111111", sector: "Large cap" },
    });
    await put({ symbol: "TSP-C", quantity: 12, valueMinor: 120000 });
    const row = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body[0];
    const detail = (
      await t.call("get", `/api/investments/securities/${row.securityId}`).expect(200)
    ).body.security;
    expect(detail).toMatchObject({ isin: "US1111111111", sector: "Large cap" });
  });

  it("refuses vesting that does not fit the position, and bad dates", async () => {
    const t = app();
    const id = await tsp(t);
    const put = (extra: Record<string, unknown>) =>
      t
        .call("put", `/api/investments/accounts/${id}/holdings`)
        .send({ holdings: [{ symbol: "TSP-C", quantity: 10, valueMinor: 100000, ...extra }] });
    await put({ vestedQuantity: 11 }).expect(400);
    await put({ vestedQuantity: -1 }).expect(400);
    await put({ vestedValueMinor: 100001 }).expect(400);
    await put({ priceAsOf: "2026-02-30" }).expect(400);
    await put({ detail: { isin: "x".repeat(40) } }).expect(400);
    await put({ detail: { unknownField: "x" } }).expect(400);
    await put({ vestedQuantity: 10, vestedValueMinor: 100000 }).expect(200);
  });

  it("imports the extra columns from a CSV file", async () => {
    const t = app();
    const id = await tsp(t);
    const csv = [
      "symbol,quantity,price,vested_quantity,vested_value,price_as_of,isin,cusip,sector,industry,subtype",
      "L 2050,1000,31.4159,800,25132.72,2026-09-29,US0000000001,000000001,Multi-asset,Target date,target date",
    ].join("\n");
    const res = await t
      .call("post", `/api/investments/accounts/${id}/import/holdings`)
      .send({ csv })
      .expect(200);
    expect(res.body.count).toBe(1);
    const row = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body[0];
    expect(row).toMatchObject({ vestedQuantity: 800, vestedValueMinor: 2513272 });
    const detail = (
      await t.call("get", `/api/investments/securities/${row.securityId}`).expect(200)
    ).body;
    expect(detail.security).toMatchObject({
      isin: "US0000000001",
      cusip: "000000001",
      sector: "Multi-asset",
      subtype: "target date",
    });
    expect(detail.positions[0].priceAsOf).toBe("2026-09-29");
    const bad = await t
      .call("post", `/api/investments/accounts/${id}/import/holdings`)
      .send({ csv: "symbol,quantity,value,price_as_of\nTSP-C,1,100,nope" })
      .expect(400);
    expect(bad.body.message).toMatch(/Row 2: "nope" is not a date/);
  });

  it("records a transaction's subtype and time, by hand and from CSV, without duplicating on re-import", async () => {
    const t = app();
    const id = await tsp(t);
    const made = await t
      .call("post", `/api/investments/accounts/${id}/transactions`)
      .send({
        date: "2026-09-15",
        type: "contribution",
        amountMinor: 60000,
        subtype: "agency matching",
        datetime: "2026-09-15T14:30",
      })
      .expect(201);
    const csv = [
      "date,type,amount,subtype,datetime",
      "2026-09-30,contribution,500.00,employee contribution,2026-09-30",
      "2026-10-01,contribution,25.00,automatic 1%,",
    ].join("\n");
    expect(
      (
        await t
          .call("post", `/api/investments/accounts/${id}/import/transactions`)
          .send({ csv })
          .expect(200)
      ).body,
    ).toEqual({ added: 2, skipped: 0 });
    expect(
      (
        await t
          .call("post", `/api/investments/accounts/${id}/import/transactions`)
          .send({ csv })
          .expect(200)
      ).body,
    ).toEqual({ added: 0, skipped: 2 });
    const rows = (await t.call("get", `/api/investments/transactions?accountId=${id}`).expect(200))
      .body.rows;
    expect(rows.find((r: { id: number }) => r.id === made.body.id)).toMatchObject({
      subtype: "agency matching",
      transactionDatetime: "2026-09-15T14:30",
    });
    expect(rows.map((r: { subtype: string }) => r.subtype).sort()).toEqual([
      "agency matching",
      "automatic 1%",
      "employee contribution",
    ]);
    await t
      .call("post", `/api/investments/accounts/${id}/transactions`)
      .send({ date: "2026-09-15", type: "buy", amountMinor: 5, datetime: "yesterday" })
      .expect(400);
    const detail = (
      await t.call("get", `/api/investments/transactions/${made.body.id}`).expect(200)
    ).body;
    expect(detail.raw).toBeNull();
  });

  it("adds up vesting for the same fund held in two accounts, but only when both know it", async () => {
    const t = app();
    const a = await tsp(t);
    const b = (
      await t.call("post", "/api/investments/accounts").send({ name: "Roth TSP" }).expect(201)
    ).body.id;
    await t
      .call("put", `/api/investments/accounts/${a}/holdings`)
      .send({
        holdings: [
          {
            symbol: "TSP-C",
            quantity: 10,
            valueMinor: 100000,
            vestedQuantity: 8,
            vestedValueMinor: 80000,
          },
        ],
      })
      .expect(200);
    await t
      .call("put", `/api/investments/accounts/${b}/holdings`)
      .send({
        holdings: [
          {
            symbol: "TSP-C",
            quantity: 5,
            valueMinor: 50000,
            vestedQuantity: 5,
            vestedValueMinor: 50000,
          },
        ],
      })
      .expect(200);
    let combined = (await t.call("get", "/api/investments/holdings?combine=1").expect(200)).body;
    expect(combined[0]).toMatchObject({
      quantity: 15,
      vestedQuantity: 13,
      vestedValueMinor: 130000,
    });
    await t
      .call("put", `/api/investments/accounts/${b}/holdings`)
      .send({ holdings: [{ symbol: "TSP-C", quantity: 5, valueMinor: 50000 }] })
      .expect(200);
    combined = (await t.call("get", "/api/investments/holdings?combine=1").expect(200)).body;
    expect(combined[0]).toMatchObject({ vestedQuantity: null, vestedValueMinor: null });
    const detail = (
      await t.call("get", `/api/investments/securities/${combined[0].securityId}`).expect(200)
    ).body;
    expect(detail.positions).toHaveLength(2);
  });
});
