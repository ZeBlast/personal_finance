import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accounts, transactions } from "../../drizzle/schema.js";
import { makeTestApp } from "./test-helpers.js";

type Ctx = ReturnType<typeof makeTestApp>;

function addAccount(ctx: Ctx): number {
  return ctx.db
    .insert(accounts)
    .values({
      name: "Checking",
      type: "depository",
      subtype: "checking",
      currency: "USD",
      currentBalanceMinor: 100000,
      isManual: true,
      source: "manual",
      createdAt: "x",
      updatedAt: "x",
    })
    .returning({ id: accounts.id })
    .get().id;
}

let sequence = 0;
function addTx(
  ctx: Ctx,
  accountId: number,
  date: string,
  amount: number,
  merchant: string,
  categoryId: number | null = null,
): void {
  sequence += 1;
  ctx.db
    .insert(transactions)
    .values({
      accountId,
      plaidTransactionId: `trend-${sequence}`,
      date,
      name: merchant,
      merchantName: merchant,
      amountMinor: amount,
      plaidCategoryPrimary: amount < 0 ? "INCOME" : null,
      currency: "USD",
      pending: false,
      isTransfer: false,
      categoryId,
      categorySource: categoryId ? "manual" : null,
      createdAt: "x",
      updatedAt: "x",
    })
    .run();
}

describe("merchant trends", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());
  const trends = async (query = "") =>
    (await ctx.call("get", `/api/reports/merchants?months=4&today=2026-05-10${query}`).expect(200))
      .body;

  it("compares whole months, keeping this month's spending apart", async () => {
    const a = addAccount(ctx);
    addTx(ctx, a, "2026-01-05", 1000, "Grocer");
    addTx(ctx, a, "2026-02-05", 1000, "Grocer");
    addTx(ctx, a, "2026-03-05", 3000, "Grocer");
    addTx(ctx, a, "2026-04-05", 3000, "Grocer");
    addTx(ctx, a, "2026-05-05", 700, "Grocer");
    addTx(ctx, a, "2026-04-06", 2000, "Cafe");
    const t = await trends();
    expect(t.months).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(t.totalMinor).toBe(10000);
    expect(t.merchants[0]).toMatchObject({
      merchant: "Grocer",
      values: [1000, 1000, 3000, 3000],
      currentMinor: 700,
      totalMinor: 8000,
      sharePercent: 80,
      earlierAverageMinor: 1000,
      recentAverageMinor: 3000,
    });
  });

  it("does not count months before any history as months of nothing", async () => {
    const a = addAccount(ctx);
    addTx(ctx, a, "2026-03-05", 2000, "Grocer");
    addTx(ctx, a, "2026-04-05", 2000, "Grocer");
    const t = await trends();
    expect(t.comparable).toBe(true);
    expect(t.merchants[0]).toMatchObject({ earlierAverageMinor: 2000, recentAverageMinor: 2000 });
  });

  it("says when one month is too little to compare", async () => {
    const a = addAccount(ctx);
    addTx(ctx, a, "2026-04-05", 2000, "Grocer");
    expect((await trends()).comparable).toBe(false);
  });

  it("narrows to one category, so shares are of that category", async () => {
    const a = addAccount(ctx);
    const food = (await ctx.call("post", "/api/categories").send({ name: "Food" }).expect(201))
      .body;
    addTx(ctx, a, "2026-04-05", 1000, "Grocer", food.id);
    addTx(ctx, a, "2026-04-06", 9000, "Airline");
    const t = await trends(`&category=${food.id}`);
    expect(t.merchants.map((m: { merchant: string }) => m.merchant)).toEqual(["Grocer"]);
    expect(t.merchants[0].sharePercent).toBe(100);
  });

  it("leaves out money coming in, such as a refund with no purchase", async () => {
    const a = addAccount(ctx);
    addTx(ctx, a, "2026-04-05", -5000, "Refunder");
    expect((await trends()).merchants).toEqual([]);
  });
});

describe("the year in review", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());
  const year = async (y: number, today: string, expected = 200) =>
    (await ctx.call("get", `/api/reports/year?year=${y}&today=${today}`).expect(expected)).body;

  it("covers January through this month, calling this month partial", async () => {
    const a = addAccount(ctx);
    addTx(ctx, a, "2026-01-05", 1000, "Shop");
    addTx(ctx, a, "2026-02-05", 3000, "Shop");
    addTx(ctx, a, "2026-03-05", 9000, "Shop");
    addTx(ctx, a, "2026-02-10", -20000, "Employer");
    const r = await year(2026, "2026-03-15");
    expect(r.months.map((m: { month: string }) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(r.months[2].partial).toBe(true);
    expect(r.months[1]).toMatchObject({
      incomeMinor: 20000,
      spendingMinor: 3000,
      savedMinor: 17000,
      partial: false,
    });
    expect(r).toMatchObject({ incomeMinor: 20000, spendingMinor: 13000, savedMinor: 7000 });
    expect(r.savingsRatePercent).toBe(35);
    // This month is not over, so it cannot be the highest or lowest yet.
    expect(r.highestMonth).toBe("2026-02");
    expect(r.lowestMonth).toBe("2026-01");
  });

  it("counts how often caps held", async () => {
    const a = addAccount(ctx);
    const food = (await ctx.call("post", "/api/categories").send({ name: "Food" }).expect(201))
      .body;
    await ctx
      .call("post", "/api/budgets")
      .send({ categoryId: food.id, month: "2026-01", amountMinor: 1000, repeats: true })
      .expect(201);
    addTx(ctx, a, "2026-01-05", 500, "Shop", food.id);
    addTx(ctx, a, "2026-02-05", 1500, "Shop", food.id);
    const r = await year(2026, "2026-03-15");
    expect(r.months.map((m: { capsHeld: number }) => m.capsHeld)).toEqual([1, 0, 1]);
    expect(r).toMatchObject({ capsHeld: 2, capsCount: 3 });
  });

  it("handles a whole past year, and an empty one", async () => {
    const r = await year(2020, "2026-03-15");
    expect(r.months).toHaveLength(12);
    expect(r.months.every((m: { partial: boolean }) => !m.partial)).toBe(true);
    expect(r).toMatchObject({ spendingMinor: 0, highestMonth: null, savingsRatePercent: null });
  });

  it("has nothing for a year not begun", async () => {
    expect((await year(2030, "2026-03-15")).months).toEqual([]);
  });
});
