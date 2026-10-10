import { afterEach, describe, expect, it } from "vitest";
import { ensureTransferSubcategories } from "./services/category.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  expect(ensureTransferSubcategories(t.db)).toBe(true);
  expect(ensureTransferSubcategories(t.db)).toBe(false); // only once
  const cats = (await t.call("get", "/api/categories").expect(200)).body as Array<{
    id: number;
    name: string;
    parentId: number | null;
    incomeTreatment: string | null;
  }>;
  const account = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Checking", kind: "checking" })
      .expect(201)
  ).body.id as number;
  const add = (
    merchant: string,
    amountMinor: number,
    direction: "in" | "out",
    categoryId?: number,
  ) =>
    t
      .call("post", "/api/transactions")
      .send({
        accountId: account,
        date: "2026-09-10",
        merchant,
        amountMinor,
        direction,
        ...(categoryId ? { categoryId } : {}),
      })
      .expect(201);
  const summary = async () =>
    (await t.call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30").expect(200)).body
      .totals as {
      incomeMinor: number;
      spendingMinor: number;
    };
  return { t, cats, add, summary };
}

describe("Credit and Refund under Transfers", () => {
  it("are added under Transfers, with how money in under them counts", async () => {
    const { cats } = await setup();
    const transfers = cats.find((c) => c.name === "Transfers" && c.parentId === null)!;
    expect(cats.find((c) => c.name === "Credit")).toMatchObject({
      parentId: transfers.id,
      incomeTreatment: "income",
    });
    expect(cats.find((c) => c.name === "Refund")).toMatchObject({
      parentId: transfers.id,
      incomeTreatment: "refund",
    });
  });

  it("counts a credit as income, and a refund as less spending, never income", async () => {
    const { cats, add, summary } = await setup();
    const credit = cats.find((c) => c.name === "Credit")!.id;
    const refund = cats.find((c) => c.name === "Refund")!.id;
    await add("Store", 10_000, "out");
    await add("Store refund", 3_000, "in", refund);
    await add("Bonus credit", 50_000, "in", credit);
    const s = await summary();
    expect(s.incomeMinor).toBe(50_000);
    expect(s.spendingMinor).toBe(10_000 - 3_000);
  });

  it("keeps a refund out of income even when it would otherwise look like income", async () => {
    const { t, cats, add, summary } = await setup();
    const refund = cats.find((c) => c.name === "Refund")!.id;
    const res = await add("Zelle from Sam", 2_000, "in", refund);
    // A sender normally makes money in count as income; the Refund category overrides that.
    await t.call("patch", `/api/transactions/${res.body.id}`).send({ sender: "Sam" }).expect(200);
    expect((await summary()).incomeMinor).toBe(0);
  });

  it("lets any category be set to count as income or as a refund, or neither", async () => {
    const { t, add, summary } = await setup();
    const gifts = (
      await t.call("post", "/api/categories").send({ name: "Gifts received" }).expect(201)
    ).body.id as number;
    await add("Birthday money", 10_000, "in", gifts);
    expect((await summary()).incomeMinor).toBe(0);
    await t
      .call("patch", `/api/categories/${gifts}`)
      .send({ incomeTreatment: "income" })
      .expect(200);
    expect((await summary()).incomeMinor).toBe(10_000);
    await t.call("patch", `/api/categories/${gifts}`).send({ incomeTreatment: null }).expect(200);
    expect((await summary()).incomeMinor).toBe(0);
    await t
      .call("patch", `/api/categories/${gifts}`)
      .send({ incomeTreatment: "salary" })
      .expect(400);
  });
});
