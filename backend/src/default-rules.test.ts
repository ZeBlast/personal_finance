import { afterEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { transactionRules } from "../../drizzle/schema.js";
import {
  ensureCategoryPack,
  ensureCreditRefundRegroup,
  ensureStarterAdditions,
  ensureTransferSubcategories,
  seedDefaults,
} from "./services/category.service.js";
import { ensureRuleImprovements } from "./services/default-rules.service.js";
import { ruleMatches } from "./services/rule.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  seedDefaults(t.db);
  ensureStarterAdditions(t.db);
  ensureTransferSubcategories(t.db);
  ensureCategoryPack(t.db);
  ensureCreditRefundRegroup(t.db);
  return t;
}

const subject = (amountMinor: number) => ({
  merchant: "Disney+",
  name: "$120 Disney Streaming Credit",
  recipient: null,
  sender: null,
  plaidPrimary: "ENTERTAINMENT",
  plaidDetailed: "ENTERTAINMENT_TV_AND_MOVIES",
  amountMinor,
});

describe("rules that know which way the money moves", () => {
  it("matches only money going out, only money coming in, or either", () => {
    const rule = {
      field: "plaid_category" as const,
      operator: "equals" as const,
      matchValue: "ENTERTAINMENT_TV_AND_MOVIES",
    };
    expect(ruleMatches({ ...rule, direction: "out" }, subject(799))).toBe(true);
    expect(ruleMatches({ ...rule, direction: "out" }, subject(-741))).toBe(false);
    expect(ruleMatches({ ...rule, direction: "in" }, subject(-741))).toBe(true);
    expect(ruleMatches({ ...rule, direction: null }, subject(-741))).toBe(true);
    // Without an amount, a rule limited to one direction does not match.
    const unknown = { ...subject(0), amountMinor: undefined };
    expect(ruleMatches({ ...rule, direction: "in" }, unknown)).toBe(false);
  });
});

describe("improving the starting rules", () => {
  it("limits some bank-category rules to money out, puts name rules first, and adds generic ones, once", () => {
    const t = setup();
    const result = ensureRuleImprovements(t.db)!;
    expect(result.rulesCreated).toBe(10);
    expect(ensureRuleImprovements(t.db)).toBeNull();

    const rules = t.db
      .select()
      .from(transactionRules)
      .orderBy(asc(transactionRules.priority), asc(transactionRules.id))
      .all();
    const bank = (code: string) => rules.find((r) => r.matchValue === code)!;
    expect(bank("ENTERTAINMENT_TV_AND_MOVIES").direction).toBe("out");
    expect(bank("TRANSPORTATION_PARKING").direction).toBe("out");
    expect(bank("FOOD_AND_DRINK").direction).toBeNull();
    expect(rules.find((r) => r.matchValue === "disney+")!.direction).toBe("out");
    expect(rules.find((r) => r.matchValue === "cash back")).toMatchObject({ direction: "in" });

    // Every name rule comes before every bank-category rule.
    const firstBank = rules.findIndex((r) => r.field === "plaid_category");
    expect(rules.slice(firstBank).every((r) => r.field === "plaid_category")).toBe(true);
  });

  it("files a cashback credit as a reimbursement and leaves a streaming charge in Streaming", async () => {
    const t = setup();
    ensureRuleImprovements(t.db);
    const account = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Card", kind: "credit_card" })
        .expect(201)
    ).body.id as number;
    const add = async (merchant: string, amountMinor: number, direction: "in" | "out") =>
      (
        await t
          .call("post", "/api/transactions")
          .send({ accountId: account, date: "2026-09-10", merchant, amountMinor, direction })
          .expect(201)
      ).body;
    expect((await add("CASH BACK REWARD", 500, "in")).category?.name).toBe("Reimbursements");
    expect((await add("Disney+", 799, "out")).category?.name).toBe("Streaming");
    expect((await add("Walmart+", 1295, "out")).category?.name).toBe("Subscriptions");
  });
});

describe("the names you go by", () => {
  it("files money to and from yourself as moving your own money, and removes the rule with the name", async () => {
    const t = setup();
    const account = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const zelle = (
      await t
        .call("post", "/api/transactions")
        .send({
          accountId: account,
          date: "2026-09-10",
          merchant: "Zelle payment from JANE DOE for Rent",
          amountMinor: 110000,
          direction: "in",
        })
        .expect(201)
    ).body.id as number;

    await t
      .call("patch", "/api/settings")
      .send({ ownNames: ["Jane Doe"] })
      .expect(200);
    const filed = (await t.call("get", `/api/transactions/${zelle}`).expect(200)).body;
    expect(filed.category?.name).toBe("Own Accounts");
    expect(filed.isTransfer).toBe(true);

    await t.call("patch", "/api/settings").send({ ownNames: [] }).expect(200);
    const after = (await t.call("get", `/api/transactions/${zelle}`).expect(200)).body;
    expect(after.category?.name).not.toBe("Own Accounts");
    expect(after.isTransfer).toBe(false);
  });
});
