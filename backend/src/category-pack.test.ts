import { afterEach, describe, expect, it } from "vitest";
import {
  ensureCategoryPack,
  ensureStarterAdditions,
  ensureTransferSubcategories,
  seedDefaults,
} from "./services/category.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Cat {
  id: number;
  name: string;
  parentId: number | null;
  incomeTreatment: string | null;
}

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  seedDefaults(t.db);
  ensureStarterAdditions(t.db);
  ensureTransferSubcategories(t.db);
  const result = ensureCategoryPack(t.db);
  const cats = (await t.call("get", "/api/categories").expect(200)).body as Cat[];
  const cat = (name: string) => cats.find((c) => c.name === name)!;
  const parentOf = (name: string) => cats.find((c) => c.id === cat(name).parentId)?.name ?? null;
  return { t, result, cats, cat, parentOf };
}

describe("the second set of starter categories", () => {
  it("adds them once, in the right places, with how their money counts", async () => {
    const { t, result, cats, cat, parentOf } = await setup();
    expect(result!.categoriesCreated).toBeGreaterThan(15);
    expect(ensureCategoryPack(t.db)).toBeNull();

    expect(
      cats
        .filter((c) => c.parentId === cat("Insurance").id)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["Auto Insurance", "Health Insurance", "Home & Renters Insurance", "Life Insurance"]);
    expect(parentOf("Insurance")).toBeNull();
    expect(parentOf("Taxes")).toBeNull();
    expect(parentOf("Gifts & Donations")).toBeNull();
    expect(parentOf("Subscriptions")).toBeNull();
    // Streaming moved under Subscriptions.
    expect(parentOf("Streaming")).toBe("Subscriptions");
    expect(parentOf("Phone & Internet")).toBe("Rent & Utilities");
    for (const name of [
      "Gas",
      "Parking & Tolls",
      "Public Transit",
      "Rideshare",
      "Car Maintenance",
      "Car Payment",
    ]) {
      expect(parentOf(name), name).toBe("Transportation");
    }
    // Health & Fitness gets no subcategories.
    expect(cats.some((c) => c.parentId === cat("Health & Fitness").id)).toBe(false);
    expect(cat("Tax Refund")).toMatchObject({ incomeTreatment: "refund" });
    expect(parentOf("Tax Refund")).toBe("Taxes");
    expect(cat("Paycheck")).toMatchObject({ incomeTreatment: "income" });
    expect(cat("Interest & Dividends")).toMatchObject({ incomeTreatment: "income" });
    expect(cat("Side Income")).toMatchObject({ incomeTreatment: "income" });
    expect(cat("Reimbursements")).toMatchObject({ incomeTreatment: "refund" });
    expect(parentOf("Cash Withdrawals")).toBe("Transfers");
    expect(parentOf("Savings & Investing")).toBe("Transfers");
    expect(cat("Cash Withdrawals")).toMatchObject({ incomeTreatment: "transfer" });
    expect(cat("Savings & Investing")).toMatchObject({ incomeTreatment: "transfer" });
  });

  it("keeps cash withdrawals and savings out of spending, and a tax refund out of income", async () => {
    const { t, cat } = await setup();
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
    const totals = async () =>
      (await t.call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30").expect(200)).body
        .totals as { incomeMinor: number; spendingMinor: number };

    const atm = await add("ATM", 10_000, "out", cat("Cash Withdrawals").id);
    await add("To brokerage", 50_000, "out", cat("Savings & Investing").id);
    await add("IRS refund", 80_000, "in", cat("Tax Refund").id);
    await add("Groceries", 6_000, "out");
    expect(await totals()).toMatchObject({ incomeMinor: 0, spendingMinor: 6_000 - 80_000 });

    const flagged = (await t.call("get", `/api/transactions/${atm.body.id}`).expect(200)).body;
    expect(flagged.isTransfer).toBe(true);
    // Moved to another category, it is spending again.
    await t
      .call("patch", `/api/transactions/${atm.body.id}`)
      .send({ categoryId: cat("Groceries").id })
      .expect(200);
    expect((await totals()).spendingMinor).toBe(16_000 - 80_000);
    // A category set to move money flags what is already in it.
    await t
      .call("patch", `/api/categories/${cat("Groceries").id}`)
      .send({ incomeTreatment: "transfer" })
      .expect(200);
    // The ATM transaction (now in Groceries) leaves spending; the uncategorized $60 stays.
    expect((await totals()).spendingMinor).toBe(6_000 - 80_000);
    await t
      .call("patch", `/api/categories/${cat("Groceries").id}`)
      .send({ incomeTreatment: null })
      .expect(200);
    expect((await totals()).spendingMinor).toBe(16_000 - 80_000);
  });

  it("never overrides the user's own transfer choice", async () => {
    const { t, cat } = await setup();
    const account = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const atm = await t
      .call("post", "/api/transactions")
      .send({
        accountId: account,
        date: "2026-09-10",
        merchant: "ATM",
        amountMinor: 2_000,
        direction: "out",
      })
      .expect(201);
    await t
      .call("patch", `/api/transactions/${atm.body.id}`)
      .send({ isTransfer: false })
      .expect(200);
    await t
      .call("patch", `/api/transactions/${atm.body.id}`)
      .send({ categoryId: cat("Cash Withdrawals").id })
      .expect(200);
    const tx = (await t.call("get", `/api/transactions/${atm.body.id}`).expect(200)).body;
    expect(tx.isTransfer).toBe(false);
  });
});
