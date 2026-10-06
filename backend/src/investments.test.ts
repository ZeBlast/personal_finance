import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  accounts,
  holdings,
  holdingSnapshots,
  investmentTransactions,
  securities,
} from "../../drizzle/schema.js";
import { FakePlaidGateway } from "./plaid/fake-gateway.js";
import { PlaidGatewayError, type HoldingsSnapshot } from "./plaid/gateway.js";
import { investmentKind } from "./plaid/real-gateway.js";
import { findKnownFund, TSP_FUNDS } from "./services/investment-funds.js";
import { createSyncService } from "./services/sync.service.js";
import { makeSyncHarness, makeTestApp, linkDemoBank } from "./test-helpers.js";
import { parseCsv, parseNumberCell } from "./utils/csv.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function harness() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  return h;
}

/** Links the demo brokerage and syncs it. */
async function brokerage(h: ReturnType<typeof harness>) {
  const linked = await linkDemoBank(h.call, "ins_fake_brokerage", "Fake Brokerage");
  await h.sync.syncItem(linked.item.id, "manual");
  return linked.item.id;
}

describe("csv reading", () => {
  it("handles quotes, escaped quotes, line breaks inside quotes, CRLF, BOM and blank lines", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""",z\r\n\r\n"two\nlines",,end\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "z"],
      ["two\nlines", "", "end"],
    ]);
  });

  it("keeps a final row that has no line ending, and rejects an unclosed quote", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(() => parseCsv('a,b\n"1,2')).toThrow(/never closed/);
    expect(parseCsv("")).toEqual([]);
  });

  it("reads numbers as spreadsheets write them", () => {
    expect(parseNumberCell("$1,234.50")).toBe(1234.5);
    expect(parseNumberCell(" (12.5) ")).toBe(-12.5);
    expect(parseNumberCell("-3")).toBe(-3);
    expect(parseNumberCell(".5")).toBe(0.5);
    expect(parseNumberCell("")).toBeNull();
    for (const bad of ["abc", "1.2.3", "12%", "1e5", "--4"]) {
      expect(() => parseNumberCell(bad), bad).toThrow(/not a number/);
    }
  });
});

describe("fund names and kinds", () => {
  it("recognizes the TSP funds by their usual names", () => {
    for (const [input, symbol] of [
      ["G Fund", "TSP-G"],
      ["TSP-C", "TSP-C"],
      ["tsp c fund", "TSP-C"],
      ["I FUND", "TSP-I"],
      ["L 2050", "TSP-L2050"],
      ["L2050 Fund", "TSP-L2050"],
      ["TSP L Income Fund", "TSP-LINCOME"],
      ["L Income", "TSP-LINCOME"],
    ] as const) {
      expect(findKnownFund(input)?.symbol, input).toBe(symbol);
    }
  });

  it("does not mistake real tickers for TSP funds", () => {
    for (const ticker of ["C", "S", "F", "G", "I", "AAPL", "", "L 2099"]) {
      expect(findKnownFund(ticker), ticker).toBeUndefined();
    }
    expect(new Set(TSP_FUNDS.map((f) => f.symbol)).size).toBe(TSP_FUNDS.length);
  });

  it("names Plaid's investment transaction types in plain words", () => {
    expect(investmentKind("buy", "buy")).toBe("buy");
    expect(investmentKind("sell", "sell")).toBe("sell");
    expect(investmentKind("fee", "account fee")).toBe("fee");
    expect(investmentKind("cash", "dividend")).toBe("dividend");
    expect(investmentKind("cash", "qualified dividend")).toBe("dividend");
    expect(investmentKind("cash", "interest")).toBe("interest");
    expect(investmentKind("cash", "contribution")).toBe("contribution");
    expect(investmentKind("cash", "deposit")).toBe("contribution");
    expect(investmentKind("cash", "withdrawal")).toBe("withdrawal");
    expect(investmentKind("transfer", "transfer")).toBe("transfer");
    expect(investmentKind("cancel", "cancel")).toBe("other");
  });
});

describe("a connected investment account (demo brokerage)", () => {
  it("stores positions, balance, and activity from a sync", async () => {
    const h = harness();
    await brokerage(h);
    const overview = (await h.call("get", "/api/investments/overview").expect(200)).body;
    expect(overview.accounts).toHaveLength(1);
    const account = overview.accounts[0];
    expect(account).toMatchObject({ name: "Plaid 401k", holdingCount: 4, source: "plaid" });
    // The account is worth what it holds.
    expect(account.valueMinor).toBe(account.holdingsValueMinor);
    expect(overview.totalValueMinor).toBe(account.valueMinor);

    const rows = (await h.call("get", "/api/investments/holdings").expect(200)).body;
    expect(rows).toHaveLength(4);
    expect(rows.map((r: { name: string }) => r.name)).toContain("Fake Total Market Index Fund");
    expect(rows.reduce((s: number, r: { valueMinor: number }) => s + r.valueMinor, 0)).toBe(
      account.valueMinor,
    );
    // Largest first.
    const values = rows.map((r: { valueMinor: number }) => r.valueMinor);
    expect([...values].sort((a, b) => b - a)).toEqual(values);

    const tx = (await h.call("get", "/api/investments/transactions?limit=200").expect(200)).body;
    expect(tx.total).toBeGreaterThan(10);
    expect(tx.rows.some((r: { type: string }) => r.type === "contribution")).toBe(true);
  });

  it("uses one money sign: cash out of the account is positive", async () => {
    const h = harness();
    await brokerage(h);
    const { rows } = (await h.call("get", "/api/investments/transactions?limit=200").expect(200))
      .body;
    for (const r of rows) {
      if (r.type === "buy") expect(r.amountMinor).toBeGreaterThan(0);
      if (r.type === "contribution" || r.type === "dividend") expect(r.amountMinor).toBeLessThan(0);
    }
  });

  it("gives an allocation that adds up, and a gain only for what has a known cost", async () => {
    const h = harness();
    await brokerage(h);
    const overview = (await h.call("get", "/api/investments/overview").expect(200)).body;
    const slices = overview.allocation as Array<{
      assetClass: string;
      valueMinor: number;
      percent: number;
    }>;
    expect(slices.map((s) => s.assetClass).sort()).toEqual(["Cash", "Funds", "Stocks"]);
    expect(slices.reduce((s, x) => s + x.percent, 0)).toBeCloseTo(100, 6);
    expect(slices.reduce((s, x) => s + x.valueMinor, 0)).toBe(overview.holdingsValueMinor);
    // The demo stock has no cost basis, so the gain is explicitly partial.
    expect(overview.costBasis.complete).toBe(false);
    const rows = (await h.call("get", "/api/investments/holdings").expect(200)).body as Array<{
      name: string;
      gainMinor: number | null;
      costBasisMinor: number | null;
      valueMinor: number;
    }>;
    expect(rows.find((r) => r.name === "Fake Apple Co.")?.gainMinor).toBeNull();
    const known = rows.filter((r) => r.costBasisMinor !== null);
    expect(overview.costBasis.knownValueMinor).toBe(known.reduce((s, r) => s + r.valueMinor, 0));
    expect(overview.costBasis.gainMinor).toBe(
      known.reduce((s, r) => s + r.valueMinor - r.costBasisMinor!, 0),
    );
  });

  it("is repeatable: syncing again adds no duplicates", async () => {
    const h = harness();
    const id = await brokerage(h);
    const countRows = () => ({
      holdings: h.db.select({ n: count() }).from(holdings).get()!.n,
      securities: h.db.select({ n: count() }).from(securities).get()!.n,
      transactions: h.db.select({ n: count() }).from(investmentTransactions).get()!.n,
    });
    const before = countRows();
    await h.sync.syncItem(id, "manual");
    expect(countRows()).toEqual(before);
    // ...but each sync is another observation for the history.
    expect(h.db.select({ n: count() }).from(holdingSnapshots).get()!.n).toBe(before.holdings * 2);
  });

  it("builds a value history from what was observed, without inventing days", async () => {
    const h = harness();
    const id = await brokerage(h);
    h.advanceDays(3);
    await h.sync.syncItem(id, "manual");
    h.advanceDays(10);
    await h.sync.syncItem(id, "manual");
    const history = (await h.call("get", "/api/investments/history").expect(200)).body;
    expect(history.total.map((p: { date: string }) => p.date)).toEqual([
      "2026-09-01",
      "2026-09-04",
      "2026-09-14",
    ]);
    // Prices drift with the date, so the value really moves between observations.
    const values = history.total.map((p: { valueMinor: number }) => p.valueMinor);
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(history.accounts[0].points).toHaveLength(3);

    const ranged = (
      await h.call("get", "/api/investments/history?from=2026-09-04&to=2026-09-04").expect(200)
    ).body;
    expect(ranged.total).toHaveLength(1);
    await h.call("get", "/api/investments/history?from=2026-13-40").expect(400);
  });

  it("counts toward net worth like any other asset", async () => {
    const h = harness();
    await brokerage(h);
    const net = (await h.call("get", "/api/analytics/overview").expect(200)).body;
    const overview = (await h.call("get", "/api/investments/overview").expect(200)).body;
    expect(net.investmentsMinor).toBe(overview.totalValueMinor);
  });

  it("cannot be edited as a manual account", async () => {
    const h = harness();
    await brokerage(h);
    const id = h.db.select({ id: accounts.id }).from(accounts).get()!.id;
    await h
      .call("put", `/api/investments/accounts/${id}/holdings`)
      .send({ holdings: [] })
      .expect(409);
    await h.call("delete", `/api/investments/accounts/${id}`).expect(409);
    await h
      .call("post", `/api/investments/accounts/${id}/import/holdings`)
      .send({ csv: "symbol,quantity,value\nX,1,1" })
      .expect(409);
    const plaidTx = h.db
      .select({ id: investmentTransactions.id })
      .from(investmentTransactions)
      .get()!;
    await h.call("delete", `/api/investments/transactions/${plaidTx.id}`).expect(409);
  });

  it("leaves bank-only connections alone: no investment data is requested", async () => {
    const h = harness();
    let asked = 0;
    class Counting extends FakePlaidGateway {
      override async getInvestmentHoldings(token: string): Promise<HoldingsSnapshot> {
        asked += 1;
        return super.getInvestmentHoldings(token);
      }
    }
    const gateway = new Counting({ now: () => h.clock.now, pageSize: 25 });
    const sync = createSyncService({
      db: h.db,
      cipher: h.cipher,
      getGateway: () => gateway,
      now: () => h.clock.now,
    });
    const linked = await linkDemoBank(h.call);
    const run = await sync.syncItem(linked.item.id, "manual");
    expect(run.status).toBe("success");
    expect(asked).toBe(0);
    expect(h.db.select({ n: count() }).from(holdings).get()!.n).toBe(0);
  });

  it("tolerates a connection that was not set up for investments", async () => {
    const h = harness();
    class NoInvestments extends FakePlaidGateway {
      override async getInvestmentHoldings(): Promise<HoldingsSnapshot> {
        throw new PlaidGatewayError("PRODUCTS_NOT_SUPPORTED", "ITEM_ERROR", "not set up");
      }
    }
    const gateway = new NoInvestments({ now: () => h.clock.now, pageSize: 25 });
    const sync = createSyncService({
      db: h.db,
      cipher: h.cipher,
      getGateway: () => gateway,
      now: () => h.clock.now,
    });
    const linked = await linkDemoBank(h.call, "ins_fake_brokerage", "Fake Brokerage");
    const run = await sync.syncItem(linked.item.id, "manual");
    expect(run.status).toBe("success");
    expect(h.db.select({ n: count() }).from(holdings).get()!.n).toBe(0);
  });

  // Both codes were seen from real Plaid: the first from a bank-style answer, the second from a
  // brokerage linked for Investments only (found when testing against Plaid Sandbox with Fidelity).
  for (const code of ["PRODUCTS_NOT_SUPPORTED", "ADDITIONAL_CONSENT_REQUIRED"]) {
    it(`syncs a brokerage that has no bank transactions at all (${code})`, async () => {
      const h = harness();
      class InvestmentsOnly extends FakePlaidGateway {
        override async syncTransactions(): Promise<never> {
          throw new PlaidGatewayError(code, "INVALID_INPUT", "no transactions for this item");
        }
      }
      const gateway = new InvestmentsOnly({ now: () => h.clock.now, pageSize: 25 });
      const sync = createSyncService({
        db: h.db,
        cipher: h.cipher,
        getGateway: () => gateway,
        now: () => h.clock.now,
      });
      const linked = await linkDemoBank(h.call, "ins_fake_brokerage", "Fake Brokerage");
      const run = await sync.syncItem(linked.item.id, "manual");
      expect(run.status).toBe("success");
      expect(h.db.select({ n: count() }).from(holdings).get()!.n).toBe(4);
    });
  }

  it("still reports a missing-consent error for a bank that has no investment accounts", async () => {
    const h = harness();
    class NoConsent extends FakePlaidGateway {
      override async syncTransactions(): Promise<never> {
        throw new PlaidGatewayError("ADDITIONAL_CONSENT_REQUIRED", "INVALID_INPUT", "no consent");
      }
    }
    const gateway = new NoConsent({ now: () => h.clock.now, pageSize: 25 });
    const sync = createSyncService({
      db: h.db,
      cipher: h.cipher,
      getGateway: () => gateway,
      now: () => h.clock.now,
    });
    const linked = await linkDemoBank(h.call);
    const run = await sync.syncItem(linked.item.id, "manual");
    expect(run.status).toBe("error");
    expect(run.errorCode).toBe("ADDITIONAL_CONSENT_REQUIRED");
  });

  it("still reports other investment errors", async () => {
    const h = harness();
    class Broken extends FakePlaidGateway {
      override async getInvestmentHoldings(): Promise<HoldingsSnapshot> {
        throw new PlaidGatewayError("INTERNAL_SERVER_ERROR", "API_ERROR", "Plaid is down");
      }
    }
    const gateway = new Broken({ now: () => h.clock.now, pageSize: 25 });
    const sync = createSyncService({
      db: h.db,
      cipher: h.cipher,
      getGateway: () => gateway,
      now: () => h.clock.now,
    });
    const linked = await linkDemoBank(h.call, "ins_fake_brokerage", "Fake Brokerage");
    const run = await sync.syncItem(linked.item.id, "manual");
    expect(run.status).toBe("error");
    expect(run.errorCode).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("a manual account (for example the TSP)", () => {
  function app() {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    return t;
  }

  async function createTsp(t: ReturnType<typeof app>): Promise<number> {
    const res = await t
      .call("post", "/api/investments/accounts")
      .send({ name: "TSP", officialName: "Thrift Savings Plan", subtype: "401k" })
      .expect(201);
    return res.body.id as number;
  }

  it("creates an account that appears with the others, without any connection", async () => {
    const t = app();
    const id = await createTsp(t);
    const list = (await t.call("get", "/api/accounts").expect(200)).body;
    expect(list).toContainEqual(
      expect.objectContaining({
        id,
        name: "TSP",
        isManual: true,
        source: "manual",
        type: "investment",
        itemId: null,
      }),
    );
    expect(list.find((a: { id: number }) => a.id === id).color).toMatch(/^#/);
    await t.call("post", "/api/investments/accounts").send({ name: "  " }).expect(400);
    await t.call("post", "/api/investments/accounts").send({ name: "x", extra: 1 }).expect(400);
  });

  it("values holdings from a price or a total, recognizes TSP funds, and updates the balance", async () => {
    const t = app();
    const id = await createTsp(t);
    const res = await t
      .call("put", `/api/investments/accounts/${id}/holdings`)
      .send({
        holdings: [
          { symbol: "G Fund", quantity: 1000.5, price: 18.4321 },
          { symbol: "TSP-C", quantity: 50, valueMinor: 250000, costBasisMinor: 200000 },
          { name: "Employer match fund", assetClass: "Funds", quantity: 1, valueMinor: 12345 },
        ],
      })
      .expect(200);
    // 1000.5 * 18.4321 = 18441.32... rounded to cents
    const gValue = Math.round(1000.5 * 18.4321 * 100);
    expect(res.body).toEqual({ totalMinor: gValue + 250000 + 12345, count: 3 });

    const rows = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body;
    expect(rows.find((r: { symbol: string }) => r.symbol === "TSP-G")).toMatchObject({
      name: "TSP G Fund (Government Securities)",
      assetClass: "Bonds",
      valueMinor: gValue,
    });
    expect(rows.find((r: { symbol: string }) => r.symbol === "TSP-C")).toMatchObject({
      assetClass: "Stocks",
      gainMinor: 50000,
    });
    expect(rows.find((r: { name: string }) => r.name === "Employer match fund")).toMatchObject({
      symbol: null,
      assetClass: "Funds",
    });

    const overview = (await t.call("get", `/api/investments/overview?accountId=${id}`).expect(200))
      .body;
    expect(overview.totalValueMinor).toBe(res.body.totalMinor);
    const [account] = (await t.call("get", "/api/accounts").expect(200)).body;
    expect(account.currentBalanceMinor).toBe(res.body.totalMinor);
    // Net worth sees it too.
    const net = (await t.call("get", "/api/analytics/overview").expect(200)).body;
    expect(net.investmentsMinor).toBe(res.body.totalMinor);
  });

  it("replaces what was there, so entering the same list again changes nothing", async () => {
    const t = app();
    const id = await createTsp(t);
    const put = (holdingsList: unknown[]) =>
      t.call("put", `/api/investments/accounts/${id}/holdings`).send({ holdings: holdingsList });
    const list = [
      { symbol: "TSP-C", quantity: 10, valueMinor: 100000 },
      { symbol: "TSP-S", quantity: 5, valueMinor: 50000 },
    ];
    await put(list).expect(200);
    await put(list).expect(200);
    expect(t.db.select({ n: count() }).from(holdings).get()!.n).toBe(2);
    expect(t.db.select({ n: count() }).from(securities).get()!.n).toBe(2);
    await put([{ symbol: "TSP-C", quantity: 12, valueMinor: 120000 }]).expect(200);
    const rows = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "TSP-C", quantity: 12, valueMinor: 120000 });
    await put([]).expect(200);
    expect(
      (await t.call("get", `/api/investments/overview?accountId=${id}`).expect(200)).body
        .totalValueMinor,
    ).toBe(0);
  });

  it("rejects bad entries and changes nothing when one row is bad", async () => {
    const t = app();
    const id = await createTsp(t);
    await t
      .call("put", `/api/investments/accounts/${id}/holdings`)
      .send({ holdings: [{ symbol: "TSP-C", quantity: 1, valueMinor: 100 }] })
      .expect(200);
    const bad: unknown[][] = [
      [
        { symbol: "TSP-C", quantity: 1, valueMinor: 100 },
        { symbol: "G Fund", quantity: 2 },
      ], // no value or price
      [
        { symbol: "TSP-C", quantity: 1, valueMinor: 100 },
        { symbol: "tsp c fund", quantity: 1, valueMinor: 5 },
      ], // same fund twice
      [{ quantity: 1, valueMinor: 100 }], // nothing to identify it
      [{ symbol: "X", quantity: 1, valueMinor: 100, asOf: "2026-02-30" }],
    ];
    for (const holdingsList of bad) {
      await t
        .call("put", `/api/investments/accounts/${id}/holdings`)
        .send({ holdings: holdingsList })
        .expect(400);
    }
    await t
      .call("put", `/api/investments/accounts/${id}/holdings`)
      .send({ holdings: [{ symbol: "X", quantity: -1, valueMinor: 1 }] })
      .expect(400);
    const rows = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body;
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("TSP-C");
  });

  it("records a point in the value history for every update", async () => {
    const t = app();
    const id = await createTsp(t);
    await t
      .call("put", `/api/investments/accounts/${id}/holdings`)
      .send({ holdings: [{ symbol: "TSP-C", quantity: 1, valueMinor: 100000 }] })
      .expect(200);
    const history = (await t.call("get", "/api/investments/history").expect(200)).body;
    expect(history.accounts[0].points.at(-1).valueMinor).toBe(100000);
    expect(history.total.at(-1).valueMinor).toBe(100000);
  });

  it("deletes the account and everything under it", async () => {
    const t = app();
    const id = await createTsp(t);
    await t
      .call("put", `/api/investments/accounts/${id}/holdings`)
      .send({ holdings: [{ symbol: "TSP-C", quantity: 1, valueMinor: 100000 }] })
      .expect(200);
    await t.call("delete", `/api/investments/accounts/${id}`).expect(204);
    expect(t.db.select({ n: count() }).from(holdings).get()!.n).toBe(0);
    expect(t.db.select({ n: count() }).from(holdingSnapshots).get()!.n).toBe(0);
    await t.call("delete", `/api/investments/accounts/${id}`).expect(404);
  });

  it("shows connected and manual accounts together in the same overview", async () => {
    const t = makeSyncHarness();
    cleanups.push(t.cleanup);
    await brokerage(t);
    const res = await t.call("post", "/api/investments/accounts").send({ name: "TSP" }).expect(201);
    await t
      .call("put", `/api/investments/accounts/${res.body.id}/holdings`)
      .send({ holdings: [{ symbol: "TSP-C", quantity: 10, valueMinor: 500000 }] })
      .expect(200);
    const overview = (await t.call("get", "/api/investments/overview").expect(200)).body;
    expect(overview.accounts.map((a: { source: string }) => a.source).sort()).toEqual([
      "manual",
      "plaid",
    ]);
    expect(overview.totalValueMinor).toBe(
      overview.accounts.reduce((s: number, a: { valueMinor: number }) => s + a.valueMinor, 0),
    );
    const combined = (await t.call("get", "/api/investments/holdings?combine=1").expect(200)).body;
    const separate = (await t.call("get", "/api/investments/holdings").expect(200)).body;
    expect(separate).toHaveLength(5);
    expect(combined).toHaveLength(5); // different securities, so nothing merges
    const alloc = overview.allocation.map((s: { assetClass: string }) => s.assetClass);
    expect(alloc).toEqual(expect.arrayContaining(["Stocks", "Funds", "Cash"]));
  });

  it("merges the same fund held in two accounts when positions are combined", async () => {
    const t = app();
    const a = await createTsp(t);
    const b = (
      await t.call("post", "/api/investments/accounts").send({ name: "Roth TSP" }).expect(201)
    ).body.id;
    for (const [id, value, cost] of [
      [a, 100000, 80000],
      [b, 50000, null],
    ] as const) {
      await t
        .call("put", `/api/investments/accounts/${id}/holdings`)
        .send({
          holdings: [{ symbol: "TSP-C", quantity: 10, valueMinor: value, costBasisMinor: cost }],
        })
        .expect(200);
    }
    const combined = (await t.call("get", "/api/investments/holdings?combine=1").expect(200)).body;
    expect(combined).toHaveLength(1);
    // Cost is unknown for one of the two, so no gain is claimed for the pair.
    expect(combined[0]).toMatchObject({
      quantity: 20,
      valueMinor: 150000,
      costBasisMinor: null,
      gainMinor: null,
    });
  });
});

describe("importing from CSV", () => {
  function app() {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    return t;
  }
  async function account(t: ReturnType<typeof app>) {
    return (await t.call("post", "/api/investments/accounts").send({ name: "TSP" }).expect(201))
      .body.id as number;
  }
  const importHoldings = (t: ReturnType<typeof app>, id: number, csv: string) =>
    t.call("post", `/api/investments/accounts/${id}/import/holdings`).send({ csv });
  const importTransactions = (t: ReturnType<typeof app>, id: number, csv: string) =>
    t.call("post", `/api/investments/accounts/${id}/import/transactions`).send({ csv });

  const HOLDINGS = [
    "Symbol,Quantity,Price,Cost Basis,As Of",
    'G Fund,"1,200.5",$17.75,"$20,000.00",2026-09-30',
    "C Fund,310.25,$98.1234,,2026-09-30",
    "L 2050,12,$30.00,,",
    "",
  ].join("\r\n");

  it("imports holdings, recognizing TSP fund names and money formats", async () => {
    const t = app();
    const id = await account(t);
    const res = await importHoldings(t, id, HOLDINGS).expect(200);
    const g = Math.round(1200.5 * 17.75 * 100);
    const c = Math.round(310.25 * 98.1234 * 100);
    expect(res.body).toEqual({ count: 3, totalMinor: g + c + 36000 });
    const rows = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body;
    expect(rows.map((r: { symbol: string }) => r.symbol).sort()).toEqual(
      ["TSP-C", "TSP-G", "TSP-L2050"].sort(),
    );
    expect(rows.find((r: { symbol: string }) => r.symbol === "TSP-G")).toMatchObject({
      costBasisMinor: 2000000,
      asOf: "2026-09-30",
    });
  });

  it("is repeatable: the second import changes nothing", async () => {
    const t = app();
    const id = await account(t);
    await importHoldings(t, id, HOLDINGS).expect(200);
    const snapshot = () => ({
      holdings: t.db
        .select()
        .from(holdings)
        .all()
        .map((h) => [h.securityId, h.quantity, h.valueMinor]),
      securities: t.db.select({ n: count() }).from(securities).get()!.n,
    });
    const first = snapshot();
    await importHoldings(t, id, HOLDINGS).expect(200);
    expect(snapshot()).toEqual(first);
  });

  it("reports problems with row numbers and imports nothing", async () => {
    const t = app();
    const id = await account(t);
    await importHoldings(t, id, "symbol,quantity,value\nTSP-C,10,1000").expect(200);
    const bad = await importHoldings(
      t,
      id,
      "symbol,quantity,value,as_of\nTSP-S,5,500,2026-09-30\nTSP-G,abc,100,\nTSP-F,2,200,not-a-date\n",
    ).expect(400);
    expect(bad.body.message).toMatch(/Nothing was imported/);
    expect(bad.body.message).toMatch(/Row 3: "abc" is not a number/);
    expect(bad.body.message).toMatch(/Row 4: "not-a-date" is not a date/);
    const rows = (await t.call("get", `/api/investments/holdings?accountId=${id}`).expect(200))
      .body;
    expect(rows.map((r: { symbol: string }) => r.symbol)).toEqual(["TSP-C"]);
  });

  it("explains missing columns and empty files", async () => {
    const t = app();
    const id = await account(t);
    expect((await importHoldings(t, id, "symbol,qty\nX,1").expect(400)).body.message).toMatch(
      /"quantity" or "shares"/,
    );
    expect((await importHoldings(t, id, "symbol,quantity\nX,1").expect(400)).body.message).toMatch(
      /"price" or a "value"/,
    );
    expect(
      (await importHoldings(t, id, "symbol,quantity,value\n").expect(400)).body.message,
    ).toMatch(/no rows/);
    expect((await importHoldings(t, id, "   \n").expect(400)).body.message).toMatch(/empty/);
    expect(
      (await importHoldings(t, id, 'symbol,quantity,value\n"X,1,1').expect(400)).body.message,
    ).toMatch(/never closed/);
  });

  const TX = [
    "date,type,symbol,quantity,price,amount,fees",
    "2026-09-01,contribution,,,,$500.00,",
    "2026-09-02,buy,C Fund,10,98.00,,",
    "2026-09-15,contribution,,,,500,",
    "2026-09-20,dividend,TSP-G,,,12.34,",
    "2026-09-25,sell,TSP-C,2,99.00,198.00,1.50",
    "2026-09-26,transfer,,,,-75.25,",
    "2026-09-26,transfer,,,,40,",
  ].join("\n");

  it("imports transactions, taking the direction from the type", async () => {
    const t = app();
    const id = await account(t);
    const res = await importTransactions(t, id, TX).expect(200);
    expect(res.body).toEqual({ added: 7, skipped: 0 });
    const { rows } = (
      await t.call("get", `/api/investments/transactions?accountId=${id}&limit=50`).expect(200)
    ).body;
    const by = (type: string, date: string) =>
      rows.find((r: { type: string; date: string }) => r.type === type && r.date === date);
    expect(by("contribution", "2026-09-01").amountMinor).toBe(-50000); // cash in
    expect(by("buy", "2026-09-02")).toMatchObject({
      amountMinor: 98000,
      quantity: 10,
      symbol: "TSP-C",
    }); // worked out
    expect(by("dividend", "2026-09-20").amountMinor).toBe(-1234);
    expect(by("sell", "2026-09-25")).toMatchObject({ amountMinor: -19800, feesMinor: 150 });
    const transfers = rows.filter((r: { type: string }) => r.type === "transfer");
    expect(
      transfers
        .map((r: { amountMinor: number }) => r.amountMinor)
        .sort((a: number, b: number) => a - b),
    ).toEqual([-4000, 7525]);
    // Newest first.
    expect(rows[0].date >= rows.at(-1).date).toBe(true);
  });

  it("is repeatable without duplicates, and still imports only what is new", async () => {
    const t = app();
    const id = await account(t);
    await importTransactions(t, id, TX).expect(200);
    const again = await importTransactions(t, id, TX).expect(200);
    expect(again.body).toEqual({ added: 0, skipped: 7 });
    const more = await importTransactions(t, id, `${TX}\n2026-09-30,fee,,,,3.00,`).expect(200);
    expect(more.body).toEqual({ added: 1, skipped: 7 });
    expect(t.db.select({ n: count() }).from(investmentTransactions).get()!.n).toBe(8);
  });

  it("keeps identical rows within one file, and is stable when re-imported", async () => {
    const t = app();
    const id = await account(t);
    const twins = "date,type,amount\n2026-09-01,contribution,100\n2026-09-01,contribution,100\n";
    expect((await importTransactions(t, id, twins).expect(200)).body).toEqual({
      added: 2,
      skipped: 0,
    });
    expect((await importTransactions(t, id, twins).expect(200)).body).toEqual({
      added: 0,
      skipped: 2,
    });
  });

  it("rejects bad rows as a whole", async () => {
    const t = app();
    const id = await account(t);
    const bad = await importTransactions(
      t,
      id,
      [
        "date,type,symbol,amount",
        "2026-09-01,contribution,,100",
        "2026-09-02,purchase,,50",
        "2026-02-30,buy,TSP-C,10",
        "2026-09-04,buy,TSP-C,-10",
        "2026-09-05,buy,TSP-C,",
      ].join("\n"),
    ).expect(400);
    expect(bad.body.message).toMatch(/Nothing was imported/);
    expect(bad.body.message).toMatch(/Row 3: "purchase" is not a transaction type/);
    expect(bad.body.message).toMatch(/Row 4: "2026-02-30" is not a date/);
    expect(bad.body.message).toMatch(/Row 5: Enter the buy amount as a positive number/);
    expect(bad.body.message).toMatch(/Row 6: Give an amount/);
    expect(t.db.select({ n: count() }).from(investmentTransactions).get()!.n).toBe(0);
    // A failed import leaves no stray funds behind either.
    expect(t.db.select({ n: count() }).from(securities).get()!.n).toBe(0);
  });

  it("adds and deletes a single transaction by hand", async () => {
    const t = app();
    const id = await account(t);
    const created = await t
      .call("post", `/api/investments/accounts/${id}/transactions`)
      .send({ date: "2026-10-01", type: "contribution", amountMinor: 25000 })
      .expect(201);
    const { rows } = (
      await t.call("get", `/api/investments/transactions?accountId=${id}`).expect(200)
    ).body;
    expect(rows).toEqual([
      expect.objectContaining({
        id: created.body.id,
        name: "Contribution",
        amountMinor: -25000,
        source: "manual",
      }),
    ]);
    await t
      .call("post", `/api/investments/accounts/${id}/transactions`)
      .send({ date: "2026-10-01", type: "buy", amountMinor: -5 })
      .expect(400);
    await t.call("delete", `/api/investments/transactions/${created.body.id}`).expect(204);
    await t.call("delete", `/api/investments/transactions/${created.body.id}`).expect(404);
  });
});

describe("link tokens for brokerages", () => {
  it("accepts a kind, and rejects an unknown one", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t.call("post", "/api/plaid/link-token").send({ kind: "investments" }).expect(200);
    await t.call("post", "/api/plaid/link-token").send({}).expect(200);
    await t.call("post", "/api/plaid/link-token").expect(200);
    await t.call("post", "/api/plaid/link-token").send({ kind: "crypto" }).expect(400);
  });

  it("asks Plaid for Investments only when linking a brokerage", async () => {
    const calls: unknown[] = [];
    const { RealPlaidGateway } = await import("./plaid/real-gateway.js");
    const api = {
      linkTokenCreate: async (body: unknown) => {
        calls.push(body);
        return { data: { link_token: "link-x", expiration: "2030-01-01T00:00:00Z" } };
      },
    };
    const gateway = new RealPlaidGateway("sandbox", api as never);
    await gateway.createLinkToken({ userId: "u", daysRequested: 90, kind: "investments" });
    await gateway.createLinkToken({ userId: "u", daysRequested: 90 });
    const [brokerageBody, bankBody] = calls as Array<Record<string, unknown>>;
    expect(brokerageBody!["products"]).toEqual(["investments"]);
    expect(brokerageBody!["transactions"]).toBeUndefined();
    expect(bankBody!["products"]).toEqual(["transactions"]);
    expect(bankBody!["optional_products"]).toEqual(["investments"]);
  });
});

describe("investment accounts from another data source", () => {
  it("are hidden when the app is set to a different Plaid environment", async () => {
    const h = harness();
    await brokerage(h);
    const manual = await h
      .call("post", "/api/investments/accounts")
      .send({ name: "TSP" })
      .expect(201);
    expect(
      (await h.call("get", "/api/investments/overview").expect(200)).body.accounts,
    ).toHaveLength(2);
    await h.call("patch", "/api/settings").send({ plaidEnvironment: "sandbox" }).expect(200);
    const overview = (await h.call("get", "/api/investments/overview").expect(200)).body;
    // Only the hand-made account remains; the demo connection belongs to the demo environment.
    expect(overview.accounts.map((a: { id: number }) => a.id)).toEqual([manual.body.id]);
    await h.call("get", "/api/investments/overview?accountId=1").expect(404);
    expect(
      h.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "investment")).all(),
    ).toHaveLength(2);
  });
});
