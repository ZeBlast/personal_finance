import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { categories, transactionRules } from "../../drizzle/schema.js";
import {
  ensureCategoryPack,
  ensureCreditRefundRegroup,
  ensureStarterAdditions,
  ensureTransferSubcategories,
  seedDefaults,
} from "./services/category.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("regrouping Credit and Refund", () => {
  it("moves Credit under Income as taxable income and folds Refund into Reimbursements, once", () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    seedDefaults(t.db);
    ensureStarterAdditions(t.db);
    ensureTransferSubcategories(t.db);
    ensureCategoryPack(t.db);
    const all = () => t.db.select().from(categories).all();
    const byName = (name: string) => all().find((c) => c.name === name);
    const refund = byName("Refund")!;
    const now = new Date().toISOString();
    t.db
      .insert(transactionRules)
      .values({
        name: "refunds",
        field: "name",
        operator: "contains",
        matchValue: "refund",
        categoryId: refund.id,
        priority: 5,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const result = ensureCreditRefundRegroup(t.db)!;
    expect(result).toMatchObject({ creditMoved: true, refundMerged: true });
    expect(ensureCreditRefundRegroup(t.db)).toBeNull();

    const income = byName("Income")!;
    expect(byName("Credit")).toMatchObject({ parentId: income.id, incomeTreatment: "income" });
    expect(byName("Refund")).toBeUndefined();
    const reimbursements = byName("Reimbursements")!;
    expect(reimbursements).toMatchObject({ parentId: income.id, incomeTreatment: "refund" });
    expect(
      t.db.select().from(transactionRules).where(eq(transactionRules.name, "refunds")).get()!
        .categoryId,
    ).toBe(reimbursements.id);
  });
});
