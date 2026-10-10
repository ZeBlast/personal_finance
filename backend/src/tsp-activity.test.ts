import { afterEach, describe, expect, it } from "vitest";
import { priceOnOrBefore } from "./services/fund-price.service.js";
import { parseActivityCsv, parseActivityDate } from "./services/tsp-activity.service.js";
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

const HEADER =
  '"VALUATION DATE","POSTING DATE","ACTIVITY TYPE","PLAN","ACCOUNT","FUND","AMOUNT","FUND NAV/PRICE","FUND UNITS",';
const row = (
  date: string,
  type: string,
  amount: string,
  price: string,
  units: string,
  fund = "L 2065",
) =>
  `"${date}","${date}","${type}","Thrift Savings Plan - Civilian","${type}","${fund}","${amount}","${price}","${units}",`;
const file = (...rows: string[]): string => [HEADER, ...rows].join("\n");

const SAMPLE = file(
  row("09-04-2024", "Match", "26.68", "17.0617", "1.563736"),
  row("06-25-2024", "Traditional", "106.72", "16.685", "6.396164"),
  row("06-25-2024", "Match", "85.38", "16.685", "5.117171"),
);

describe("reading the activity file", () => {
  it("reads the dates, funds, amounts, prices and units, oldest first", () => {
    expect(parseActivityDate("09-04-2024")).toBe("2024-09-04");
    expect(parseActivityDate("9/4/2024")).toBe("2024-09-04");
    expect(parseActivityDate("13-40-2024")).toBeNull();
    const parsed = parseActivityCsv(SAMPLE);
    expect(parsed.rows.map((r) => [r.date, r.activity])).toEqual([
      ["2024-06-25", "Match"],
      ["2024-06-25", "Traditional"],
      ["2024-09-04", "Match"],
    ]);
    expect(parsed.rows[0]).toMatchObject({
      symbol: "TSP-L2065",
      amountMinor: 8538,
      price: 16.685,
      units: 5.117171,
    });
  });

  it("counts funds it does not know instead of guessing, and refuses other files", () => {
    const parsed = parseActivityCsv(
      file(row("09-04-2024", "Match", "5", "10", "0.5", "Mystery Fund")),
    );
    expect(parsed).toEqual({ rows: [], skipped: 1 });
    expect(() => parseActivityCsv("a,b\n1,2")).toThrow(/Investment Activity Detail/);
    expect(() => parseActivityCsv('"VALUATION DATE","FUND"\n')).toThrow(/missing a column/);
  });
});

describe("importing the activity file", () => {
  async function tspAccount(t: ReturnType<typeof app>): Promise<number> {
    const created = await t
      .call("post", "/api/tsp/accounts")
      .send({ name: "TSP", allocations: [{ symbol: "TSP-L2065", percent: 100 }] })
      .expect(201);
    return created.body.id as number;
  }
  const holding = (t: ReturnType<typeof app>, id: number) =>
    t.sqlite
      .prepare(
        "SELECT h.quantity AS quantity, h.cost_basis_minor AS cost FROM holdings h JOIN securities s ON s.id = h.security_id WHERE h.account_id = ? AND s.symbol = 'TSP-L2065'",
      )
      .get(id) as { quantity: number; cost: number } | undefined;

  it("records each row as a contribution and keeps the prices, without touching holdings by default", async () => {
    const t = app();
    const id = await tspAccount(t);
    const res = await t
      .call("post", `/api/accounts/${id}/tsp/activity/import`)
      .send({ csv: SAMPLE })
      .expect(200);
    expect(res.body).toMatchObject({
      rows: 3,
      added: 3,
      alreadyThere: 0,
      from: "2024-06-25",
      to: "2024-09-04",
      holdingsUpdated: false,
    });
    const txs = t.sqlite
      .prepare(
        "SELECT date, type, name, quantity, price, amount_minor AS amount FROM investment_transactions WHERE account_id = ? ORDER BY date, name",
      )
      .all(id) as Array<{ type: string; amount: number; quantity: number; name: string }>;
    expect(txs).toHaveLength(3);
    expect(txs[0]).toMatchObject({ type: "contribution", amount: -8538, quantity: 5.117171 });
    expect(txs[0]!.name).toMatch(/^Match/);
    expect(holding(t, id)).toBeUndefined();
    expect(priceOnOrBefore(t.db, "TSP-L2065", "2024-07-01")!.price).toBe(16.685);
  });

  it("adds the units to the holdings when asked, once, however often the file is imported", async () => {
    const t = app();
    const id = await tspAccount(t);
    const send = () =>
      t
        .call("post", `/api/accounts/${id}/tsp/activity/import`)
        .send({ csv: SAMPLE, updateHoldings: true })
        .expect(200);
    const first = await send();
    expect(first.body).toMatchObject({ added: 3, holdingsUpdated: true });
    const units = 1.563736 + 6.396164 + 5.117171;
    expect(holding(t, id)!.quantity).toBeCloseTo(units, 6);
    expect(holding(t, id)!.cost).toBe(2668 + 10672 + 8538);

    const again = await send();
    expect(again.body).toMatchObject({ added: 0, alreadyThere: 3, holdingsUpdated: false });
    expect(holding(t, id)!.quantity).toBeCloseTo(units, 6);
    expect(
      t.sqlite
        .prepare("SELECT COUNT(*) AS n FROM investment_transactions WHERE account_id = ?")
        .get(id),
    ).toEqual({ n: 3 });
  });

  it("refuses an account that is not a TSP account, and a file that is not the activity file", async () => {
    const t = app();
    const id = await tspAccount(t);
    await t
      .call("post", "/api/accounts/9999/tsp/activity/import")
      .send({ csv: SAMPLE })
      .expect(404);
    const bad = await t
      .call("post", `/api/accounts/${id}/tsp/activity/import`)
      .send({ csv: "hello" })
      .expect(400);
    expect(bad.body.error).toBe("invalid_activity_file");
  });
});
