import { afterEach, describe, expect, it } from "vitest";
import { bucketsFor } from "./services/category-trends.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("trend buckets", () => {
  it("cover the period by week (Monday first), month, quarter, and year", () => {
    expect(bucketsFor("month", "2026-01-15", "2026-03-02").map((b) => b.key)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(
      bucketsFor("quarter", "2025-11-01", "2026-04-01").map((b) => [b.key, b.from, b.to]),
    ).toEqual([
      ["2025-Q4", "2025-10-01", "2025-12-31"],
      ["2026-Q1", "2026-01-01", "2026-03-31"],
      ["2026-Q2", "2026-04-01", "2026-06-30"],
    ]);
    // 2026-10-07 is a Wednesday: its week starts Monday the 5th.
    expect(bucketsFor("week", "2026-10-07", "2026-10-13").map((b) => b.key)).toEqual([
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(bucketsFor("year", "2025-06-01", "2026-01-01").map((b) => b.label)).toEqual([
      "2025",
      "2026",
    ]);
  });
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const cat = (name: string, parent: number | null = null) =>
    (
      t.sqlite
        .prepare(
          "insert into categories (name, parent_id, color, created_at, updated_at) values (?, ?, '#f00', '2026-01-01', '2026-01-01') returning id",
        )
        .get(name, parent) as { id: number }
    ).id;
  const food = cat("Food & Drink");
  const groceries = cat("Groceries", food);
  const fun = cat("Fun");
  const make = async (name: string) =>
    (await t.call("post", "/api/accounts/manual").send({ name, kind: "cash" }).expect(201)).body
      .id as number;
  const wallet = await make("Wallet");
  const jar = await make("Jar");
  const add = (
    accountId: number,
    date: string,
    amountMinor: number,
    categoryId: number | null,
    direction = "out",
  ) =>
    t
      .call("post", "/api/transactions")
      .send({ accountId, date, merchant: "Shop", amountMinor, direction, categoryId })
      .expect(201);
  await add(wallet, "2026-07-10", 1_000, food);
  await add(wallet, "2026-08-03", 2_000, groceries);
  await add(wallet, "2026-08-20", 500, food);
  await add(jar, "2026-09-01", 4_000, groceries);
  await add(wallet, "2026-09-02", 700, fun);
  await add(wallet, "2026-09-05", 300, groceries, "in"); // a refund
  // The period before (May–June), for comparing.
  await add(wallet, "2026-06-15", 900, groceries);
  const trends = async (query: string) =>
    (await t.call("get", `/api/analytics/category-trends?${query}`).expect(200)).body;
  return { food, groceries, fun, wallet, jar, trends };
}

describe("category trends", () => {
  it("show a category over time, its subcategories inside it, refunds taking away", async () => {
    const { food, trends } = await setup();
    const r = await trends(`from=2026-07-01&to=2026-09-30&interval=month&categories=${food}`);
    expect(r.buckets.map((b: { key: string }) => b.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(r.series).toHaveLength(1);
    expect(r.series[0]).toMatchObject({
      label: "Food & Drink",
      values: [1_000, 2_500, 3_700],
      counts: [1, 2, 2],
    });
    // All spending per month, every category (Fun in September).
    expect(r.allSpending).toEqual([1_000, 2_500, 4_400]);
    // The three months before: only the June grocery shopping.
    expect(r.series[0]).toMatchObject({ previousTotal: 900, previousCount: 1 });
    expect(r.previous).toEqual({ from: "2026-04-01", to: "2026-06-30" });
  });

  it("split a category into its subcategories, the parent's own spending apart", async () => {
    const { food, trends } = await setup();
    const r = await trends(
      `from=2026-07-01&to=2026-09-30&interval=month&categories=${food}&split=1`,
    );
    const byLabel = Object.fromEntries(
      r.series.map((s: { label: string; values: number[] }) => [s.label, s.values]),
    );
    expect(byLabel).toEqual({
      Groceries: [0, 2_000, 3_700],
      "Food & Drink (general)": [1_000, 500, 0],
    });
  });

  it("keep a chosen subcategory apart from its parent, with no double counting", async () => {
    const { food, groceries, trends } = await setup();
    const r = await trends(`from=2026-07-01&to=2026-09-30&categories=${food},${groceries}`);
    const byLabel = Object.fromEntries(
      r.series.map((s: { label: string; values: number[] }) => [s.label, s.values]),
    );
    expect(byLabel).toEqual({ Groceries: [0, 2_000, 3_700], "Food & Drink": [1_000, 500, 0] });
  });

  it("filter by account, and default to every top-level category", async () => {
    const { food, jar, trends } = await setup();
    const one = await trends(`from=2026-07-01&to=2026-09-30&categories=${food}&accounts=${jar}`);
    expect(one.series[0].values).toEqual([0, 0, 4_000]);
    const all = await trends(`from=2026-07-01&to=2026-09-30&interval=quarter`);
    const totals = Object.fromEntries(
      all.series.map((s: { label: string; values: number[] }) => [s.label, s.values[0]]),
    );
    expect(totals).toMatchObject({ "Food & Drink": 7_200, Fun: 700 });
  });

  it("refuse a backwards period, and weeks over too long a one", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t.call("get", "/api/analytics/category-trends?from=2026-09-01&to=2026-01-01").expect(400);
    await t
      .call("get", "/api/analytics/category-trends?from=2020-01-01&to=2026-01-01&interval=week")
      .expect(400);
  });
});
