import { afterEach, describe, expect, it } from "vitest";
import { seedDefaults } from "./services/category.service.js";
import { amountQuery } from "./services/transaction.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  seedDefaults(t.db);
  const cats = (await t.call("get", "/api/categories").expect(200)).body as Array<{
    id: number;
    name: string;
  }>;
  const cat = (name: string) => cats.find((c) => c.name === name)!.id;
  const account = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Card", kind: "checking" })
      .expect(201)
  ).body.id as number;
  const target = (
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: account,
        date: "2026-09-12",
        merchant: "Target",
        amountMinor: 10_000,
        direction: "out",
        categoryId: cat("Shopping"),
      })
      .expect(201)
  ).body.id as number;
  const byCategory = async () => {
    const res = await t
      .call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30&groupBy=category")
      .expect(200);
    return Object.fromEntries(
      (res.body.rows as Array<{ label: string; spendingMinor: number; count: number }>).map((r) => [
        r.label,
        r.spendingMinor,
      ]),
    ) as Record<string, number>;
  };
  return { t, cat, target, byCategory };
}

describe("split transactions", () => {
  it("count each part in its own category, and the total once", async () => {
    const { t, cat, target, byCategory } = await setup();
    expect(await byCategory()).toEqual({ Shopping: 10_000 });
    const res = await t
      .call("put", `/api/transactions/${target}/splits`)
      .send({
        parts: [
          { categoryId: cat("Groceries"), amountMinor: 6_000, note: "food" },
          { categoryId: cat("Home"), amountMinor: 4_000 },
        ],
      })
      .expect(200);
    expect(
      res.body.splits.map((s: { categoryName: string; amountMinor: number }) => [
        s.categoryName,
        s.amountMinor,
      ]),
    ).toEqual([
      ["Groceries", 6_000],
      ["Home", 4_000],
    ]);
    expect(res.body.splitValid).toBe(true);
    expect(await byCategory()).toEqual({ Groceries: 6_000, Home: 4_000 });
    const totals = (
      await t.call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30").expect(200)
    ).body.totals;
    expect(totals.spendingMinor).toBe(10_000);
    // Filtering the list by a part's category finds it.
    const list = (await t.call("get", `/api/transactions?category=${cat("Home")}`).expect(200))
      .body;
    expect(list.items.map((x: { id: number }) => x.id)).toEqual([target]);
    // Un-splitting puts it back in its own category.
    await t.call("put", `/api/transactions/${target}/splits`).send({ parts: [] }).expect(200);
    expect(await byCategory()).toEqual({ Shopping: 10_000 });
  });

  it("refuses parts that do not add up, and a single part", async () => {
    const { t, cat, target } = await setup();
    const bad = await t
      .call("put", `/api/transactions/${target}/splits`)
      .send({
        parts: [
          { categoryId: cat("Groceries"), amountMinor: 6_000 },
          { categoryId: null, amountMinor: 3_000 },
        ],
      })
      .expect(400);
    expect(bad.body.message).toContain("add up to $90.00");
    await t
      .call("put", `/api/transactions/${target}/splits`)
      .send({ parts: [{ categoryId: cat("Groceries"), amountMinor: 10_000 }] })
      .expect(400);
  });

  it("counts the transaction whole again if its amount changes and the parts no longer add up", async () => {
    const { t, cat, target, byCategory } = await setup();
    await t
      .call("put", `/api/transactions/${target}/splits`)
      .send({
        parts: [
          { categoryId: cat("Groceries"), amountMinor: 6_000 },
          { categoryId: cat("Home"), amountMinor: 4_000 },
        ],
      })
      .expect(200);
    await t.call("patch", `/api/transactions/${target}`).send({ amountMinor: 12_000 }).expect(200);
    expect(await byCategory()).toEqual({ Shopping: 12_000 });
    const tx = (await t.call("get", `/api/transactions/${target}`).expect(200)).body;
    expect(tx.splitValid).toBe(false);
  });
});

describe("searching by amount", () => {
  it("finds a transaction by its amount, written any usual way", async () => {
    const { t, target } = await setup();
    for (const q of ["100", "100.00", "$100", "100.0"]) {
      const res = await t.call("get", `/api/transactions?q=${encodeURIComponent(q)}`).expect(200);
      expect(
        res.body.items.map((x: { id: number }) => x.id),
        q,
      ).toEqual([target]);
    }
    expect((await t.call("get", "/api/transactions?q=99.99").expect(200)).body.items).toHaveLength(
      0,
    );
    expect(amountQuery("1,200.50")).toBe(120_050);
    expect(amountQuery("Target")).toBeNull();
  });
});
