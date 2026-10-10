import {
  ensureCategoryPack,
  ensureTransferSubcategories,
  seedDefaults,
} from "./services/category.service.js";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  ensureTransferSubcategories(t.db);
  const cats = (await t.call("get", "/api/categories").expect(200)).body as Array<{
    id: number;
    name: string;
  }>;
  const account = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Checking", kind: "checking" })
      .expect(201)
  ).body.id as number;
  const add = async (
    date: string,
    merchant: string,
    amountMinor: number,
    direction: "in" | "out",
    extra: { categoryId?: number; sender?: string } = {},
  ) => {
    const res = await t
      .call("post", "/api/transactions")
      .send({
        accountId: account,
        date,
        merchant,
        amountMinor,
        direction,
        ...(extra.categoryId ? { categoryId: extra.categoryId } : {}),
      })
      .expect(201);
    if (extra.sender) {
      await t
        .call("patch", `/api/transactions/${res.body.id}`)
        .send({ sender: extra.sender })
        .expect(200);
    }
  };
  return { t, cats, add };
}

describe("taxes", () => {
  it("lists the year's income and credits, grouped by source", async () => {
    const { t, cats, add } = await setup();
    const credit = cats.find((c) => c.name === "Credit")!.id;
    const refund = cats.find((c) => c.name === "Refund")!.id;
    await add("2026-01-15", "ACME PAYROLL", 300_000, "in", { sender: "Acme Corp" });
    await add("2026-02-15", "ACME PAYROLL", 300_000, "in", { sender: "Acme Corp" });
    await add("2026-03-01", "Sign-up bonus", 20_000, "in", { categoryId: credit });
    await add("2026-03-02", "Store refund", 5_000, "in", { categoryId: refund });
    await add("2026-03-03", "Groceries", 8_000, "out");
    await add("2025-12-15", "ACME PAYROLL", 300_000, "in", { sender: "Acme Corp" });

    const body = (await t.call("get", "/api/taxes/2026").expect(200)).body;
    expect(body.transactions).toHaveLength(3);
    expect(body.sources).toEqual([
      expect.objectContaining({
        label: "Acme Corp",
        kind: "income",
        totalMinor: 600_000,
        count: 2,
        wages: true,
      }),
      expect.objectContaining({
        key: "credit",
        kind: "credit",
        totalMinor: 20_000,
        count: 1,
        wages: false,
      }),
    ]);
    expect(body.profile).toBeNull();
  });

  it("saves the answers for a year", async () => {
    const { t } = await setup();
    const profile = {
      filingStatus: "single",
      state: "MD",
      marylandCounty: "montgomery",
      customLocalRate: null,
      customLocalName: null,
      federalWithheld: 9000,
      stateWithheld: null,
      sources: [
        {
          key: "income:acme corp",
          label: "Acme Corp",
          annualIncome: 72000,
          ficaExempt: false,
          pretaxRetirement: 5000,
          pretaxBenefits: 1200,
          excluded: false,
        },
      ],
    };
    await t.call("put", "/api/taxes/2026/profile").send(profile).expect(200);
    expect((await t.call("get", "/api/taxes/2026").expect(200)).body.profile).toEqual(profile);
    expect((await t.call("get", "/api/taxes/2025").expect(200)).body.profile).toBeNull();
    await t
      .call("put", "/api/taxes/2026/profile")
      .send({ ...profile, state: "CA" })
      .expect(400);
    await t.call("delete", "/api/taxes/2026/profile").expect(204);
    expect((await t.call("get", "/api/taxes/2026").expect(200)).body.profile).toBeNull();
  });
});

describe("pay filed under Income", () => {
  it("stays income on the Taxes page, while Transfers > Credit is a credit", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    seedDefaults(t.db);
    ensureTransferSubcategories(t.db);
    ensureCategoryPack(t.db);
    const cats = (await t.call("get", "/api/categories").expect(200)).body as Array<{
      id: number;
      name: string;
    }>;
    const cat = (name: string) => cats.find((c) => c.name === name)!.id;
    const account = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const add = (merchant: string, categoryId: number) =>
      t
        .call("post", "/api/transactions")
        .send({
          accountId: account,
          date: "2026-03-05",
          merchant,
          amountMinor: 100_000,
          direction: "in",
          categoryId,
        })
        .expect(201);
    await add("ACME PAYROLL", cat("Paycheck"));
    await add("Bonus credit", cat("Credit"));
    const body = (await t.call("get", "/api/taxes/2026").expect(200)).body;
    const kinds = Object.fromEntries(
      body.sources.map((s: { label: string; kind: string }) => [s.label, s.kind]),
    );
    expect(kinds).toEqual({ "ACME PAYROLL": "income", Credits: "credit" });
  });
});
