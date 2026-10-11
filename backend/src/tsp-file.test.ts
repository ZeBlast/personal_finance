import { afterEach, describe, expect, it } from "vitest";
import { writeHoldings } from "./services/tsp.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
const app = () => {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
};

describe("TSP files", () => {
  it("move a TSP account, with its history, to another copy of the app", async () => {
    const t = app();
    const id = (
      await t
        .call("post", "/api/tsp/accounts")
        .send({ name: "My TSP", allocations: [{ symbol: "TSP-L2065", percent: 100 }] })
        .expect(201)
    ).body.id as number;
    const chart = ['"Jun 2, 2025 to Jun 6, 2025","L 2065"'];
    for (let d = 2; d <= 6; d++) chart.push(`"2025-06-0${d} 00:00:00",10.0000`);
    await t
      .call("post", "/api/tsp/prices/import")
      .send({ csv: chart.join("\n") })
      .expect(200);
    writeHoldings(
      t.db,
      id,
      [
        {
          symbol: "TSP-L2065",
          name: "L 2065",
          assetClass: "Funds",
          quantity: 115,
          costBasisMinor: null,
          fallbackPrice: null,
          fallbackValueMinor: 0,
        },
      ],
      "2026-10-10",
      "2026-10-10T12:00:00.000Z",
    );
    const activity = [
      '"VALUATION DATE","POSTING DATE","ACTIVITY TYPE","PLAN","ACCOUNT","FUND","AMOUNT","FUND NAV/PRICE","FUND UNITS",',
      '"06-04-2025","06-05-2025","Traditional","Thrift Savings Plan - Civilian","Traditional","L 2065","150.00","10.0000","15.000000",',
    ];
    await t
      .call("post", `/api/accounts/${id}/tsp/activity/import`)
      .send({ csv: activity.join("\n"), updateHoldings: false })
      .expect(200);
    await t
      .call("post", `/api/accounts/${id}/tsp/contributions`)
      .send({ amountMinor: 20_000, frequency: "biweekly", startDate: "2026-01-02" })
      .expect(201);

    const file = (await t.call("get", `/api/accounts/${id}/tsp/export`).expect(200)).body;
    expect(file).toMatchObject({ format: "personal-finance-tsp", account: { name: "My TSP" } });

    const other = app();
    const made = (await other.call("post", "/api/tsp/import").send(file).expect(201)).body;
    const count = (db: typeof t.sqlite, table: string, account: number) =>
      (
        db.prepare(`select count(*) as n from ${table} where account_id = ?`).get(account) as {
          n: number;
        }
      ).n;
    for (const table of [
      "holdings",
      "holding_snapshots",
      "investment_transactions",
      "balance_snapshots",
      "tsp_allocations",
      "tsp_contributions",
    ]) {
      expect(count(other.sqlite, table, made.id), table).toBe(count(t.sqlite, table, id));
    }
    const prices = (db: typeof t.sqlite) =>
      (db.prepare("select count(*) as n from fund_prices").get() as { n: number }).n;
    expect(prices(other.sqlite)).toBe(prices(t.sqlite));
    const balance = (db: typeof t.sqlite, account: number) =>
      (
        db.prepare("select current_balance_minor as v from accounts where id = ?").get(account) as {
          v: number;
        }
      ).v;
    expect(balance(other.sqlite, made.id)).toBe(balance(t.sqlite, id));
    expect(made.settings).toMatchObject({ allocations: [{ symbol: "TSP-L2065" }] });
  });

  it("refuse a file that is not a TSP export, and export only TSP accounts", async () => {
    const t = app();
    await t.call("post", "/api/tsp/import").send({ format: "nope" }).expect(400);
    const cash = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id;
    await t.call("get", `/api/accounts/${cash}/tsp/export`).expect(404);
  });
});
