import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { categories, transactionRules, transactions } from "../../drizzle/schema.js";
import { seedDefaults } from "./services/category.service.js";
import {
  firstMatch,
  ruleMatches,
  type RuleRow,
  type RuleSubject,
} from "./services/rule.service.js";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";

type Ctx = ReturnType<typeof makeTestApp>;

const makeCategory = async (
  ctx: Ctx,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: number; name: string; parentId: number | null; active: boolean }> =>
  (
    await ctx
      .call("post", "/api/categories")
      .send({ name, ...extra })
      .expect(201)
  ).body;

describe("categories", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("creates and lists categories, tidying the name", async () => {
    const created = await makeCategory(ctx, "  Pet   Care  ", { color: "#AABBCC" });
    expect(created).toMatchObject({
      name: "Pet Care",
      parentId: null,
      active: true,
      color: "#aabbcc",
    });
    await makeCategory(ctx, "Books");
    const list = (await ctx.call("get", "/api/categories").expect(200)).body;
    expect(list.map((c: { name: string }) => c.name)).toEqual(["Books", "Pet Care"]);
    expect(list[0]).toMatchObject({ transactionCount: 0, ruleCount: 0 });
  });

  it("rejects bad names and colors", async () => {
    await ctx.call("post", "/api/categories").send({ name: "   " }).expect(400);
    await ctx
      .call("post", "/api/categories")
      .send({ name: "x".repeat(61) })
      .expect(400);
    await ctx.call("post", "/api/categories").send({ name: "A", color: "blue" }).expect(400);
    await ctx.call("post", "/api/categories").send({ name: "A", surprise: 1 }).expect(400);
    await ctx.call("post", "/api/categories").send({}).expect(400);
  });

  it("does not allow two categories with the same name in the same place, ignoring case", async () => {
    await makeCategory(ctx, "Pets");
    const res = await ctx.call("post", "/api/categories").send({ name: "pETS" }).expect(409);
    expect(res.body.error).toBe("duplicate_name");
    // The same name under a different parent is fine.
    const parent = await makeCategory(ctx, "Home");
    await makeCategory(ctx, "Pets", { parentId: parent.id });
  });

  it("nests one level deep only", async () => {
    const parent = await makeCategory(ctx, "Home");
    const child = await makeCategory(ctx, "Repairs", { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(
      (
        await ctx
          .call("post", "/api/categories")
          .send({ name: "Deep", parentId: child.id })
          .expect(400)
      ).body.error,
    ).toBe("too_deep");
    await ctx.call("post", "/api/categories").send({ name: "Orphan", parentId: 999 }).expect(404);
    expect(
      (
        await ctx
          .call("patch", `/api/categories/${parent.id}`)
          .send({ parentId: parent.id })
          .expect(400)
      ).body.error,
    ).toBe("invalid_parent");
    // A category with subcategories cannot become a subcategory itself.
    const other = await makeCategory(ctx, "Other group");
    expect(
      (
        await ctx
          .call("patch", `/api/categories/${parent.id}`)
          .send({ parentId: other.id })
          .expect(400)
      ).body.error,
    ).toBe("too_deep");
    // A subcategory can move to the top level.
    const moved = (
      await ctx.call("patch", `/api/categories/${child.id}`).send({ parentId: null }).expect(200)
    ).body;
    expect(moved.parentId).toBeNull();
  });

  it("renames, recolors, and refuses a rename that clashes", async () => {
    const a = await makeCategory(ctx, "Alpha");
    await makeCategory(ctx, "Beta");
    expect(
      (await ctx.call("patch", `/api/categories/${a.id}`).send({ name: "Beta" }).expect(409)).body
        .error,
    ).toBe("duplicate_name");
    expect(
      (
        await ctx
          .call("patch", `/api/categories/${a.id}`)
          .send({ name: "Alpha", color: "#112233" })
          .expect(200)
      ).body,
    ).toMatchObject({ name: "Alpha", color: "#112233" });
    expect(
      (await ctx.call("patch", `/api/categories/${a.id}`).send({ name: "Gamma" }).expect(200)).body
        .name,
    ).toBe("Gamma");
    await ctx.call("patch", `/api/categories/${a.id}`).send({}).expect(400);
    await ctx.call("patch", "/api/categories/999").send({ name: "x" }).expect(404);
  });

  it("archives a group together with its subcategories and can restore it", async () => {
    const parent = await makeCategory(ctx, "Home");
    const child = await makeCategory(ctx, "Repairs", { parentId: parent.id });
    await ctx.call("patch", `/api/categories/${parent.id}`).send({ active: false }).expect(200);
    const hidden = (await ctx.call("get", "/api/categories").expect(200)).body;
    expect(hidden).toEqual([]);
    const all = (await ctx.call("get", "/api/categories?includeInactive=1").expect(200)).body;
    expect(all.map((c: { active: boolean }) => c.active)).toEqual([false, false]);
    await ctx
      .call("post", "/api/categories")
      .send({ name: "New", parentId: parent.id })
      .expect(400); // archived parent
    await ctx.call("patch", `/api/categories/${parent.id}`).send({ active: true }).expect(200);
    const after = (await ctx.call("get", "/api/categories").expect(200)).body;
    expect(after.map((c: { id: number }) => c.id)).toEqual([parent.id]); // the child stays archived until restored itself
    await ctx.call("patch", `/api/categories/${child.id}`).send({ active: true }).expect(200);
  });

  it("deletes an unused category for real", async () => {
    const c = await makeCategory(ctx, "Temporary");
    const res = (await ctx.call("delete", `/api/categories/${c.id}`).expect(200)).body;
    expect(res).toMatchObject({ outcome: "deleted", transactionCount: 0, ruleCount: 0 });
    expect(ctx.db.select().from(categories).all()).toHaveLength(0);
    await ctx.call("delete", `/api/categories/${c.id}`).expect(404);
  });

  it("archives instead of deleting a category that is in use, keeping history intact", async () => {
    const c = await makeCategory(ctx, "Groceries");
    await ctx
      .call("post", "/api/rules")
      .send({
        name: "r",
        field: "merchant",
        operator: "contains",
        matchValue: "x",
        categoryId: c.id,
      })
      .expect(201);
    const res = (await ctx.call("delete", `/api/categories/${c.id}`).expect(200)).body;
    expect(res).toMatchObject({ outcome: "archived", ruleCount: 1 });
    const row = ctx.db.select().from(categories).where(eq(categories.id, c.id)).get()!;
    expect(row.active).toBe(false);
    expect(ctx.db.select().from(transactionRules).all()).toHaveLength(1);
  });

  it("archives a category that has subcategories rather than orphaning them", async () => {
    const parent = await makeCategory(ctx, "Home");
    const child = await makeCategory(ctx, "Repairs", { parentId: parent.id });
    expect(
      (await ctx.call("delete", `/api/categories/${parent.id}`).expect(200)).body.outcome,
    ).toBe("archived");
    const rows = ctx.db.select().from(categories).all();
    expect(rows.find((r) => r.id === child.id)!.active).toBe(false);
  });

  it("moves transactions and rules to another category when asked, then deletes", async () => {
    const h = makeSyncHarness();
    try {
      const from = await makeCategory(h, "Old");
      const to = await makeCategory(h, "New");
      const { item } = await linkDemoBank(h.call);
      await h.sync.syncItem(item.id, "manual");
      const tx = h.db.select({ id: transactions.id }).from(transactions).get()!;
      await h.call("patch", `/api/transactions/${tx.id}`).send({ categoryId: from.id }).expect(200);
      await h
        .call("post", "/api/rules")
        .send({
          name: "r",
          field: "merchant",
          operator: "contains",
          matchValue: "zzz",
          categoryId: from.id,
        })
        .expect(201);

      const res = (
        await h.call("delete", `/api/categories/${from.id}?reassignTo=${to.id}`).expect(200)
      ).body;
      expect(res).toMatchObject({ outcome: "deleted", transactionCount: 1, ruleCount: 1 });
      expect(
        h.db.select().from(categories).where(eq(categories.id, from.id)).get(),
      ).toBeUndefined();
      expect(
        (await h.call("get", `/api/transactions/${tx.id}`).expect(200)).body.category,
      ).toMatchObject({ id: to.id, source: "manual" });
      expect(h.db.select().from(transactionRules).get()!.categoryId).toBe(to.id);
    } finally {
      h.cleanup();
    }
  });

  it("refuses bad reassign targets", async () => {
    const a = await makeCategory(ctx, "A");
    const parent = await makeCategory(ctx, "P");
    await makeCategory(ctx, "Kid", { parentId: parent.id });
    const archived = await makeCategory(ctx, "Archived");
    await ctx.call("patch", `/api/categories/${archived.id}`).send({ active: false }).expect(200);
    expect(
      (await ctx.call("delete", `/api/categories/${a.id}?reassignTo=${a.id}`).expect(400)).body
        .error,
    ).toBe("invalid_target");
    expect(
      (await ctx.call("delete", `/api/categories/${a.id}?reassignTo=${archived.id}`).expect(400))
        .body.error,
    ).toBe("inactive_category");
    expect(
      (await ctx.call("delete", `/api/categories/${parent.id}?reassignTo=${a.id}`).expect(409)).body
        .error,
    ).toBe("has_children");
    await ctx.call("delete", `/api/categories/${a.id}?reassignTo=999`).expect(404);
    await ctx.call("delete", `/api/categories/${a.id}?reassignTo=abc`).expect(400);
  });

  it("requires the API token", async () => {
    const { default: request } = await import("supertest");
    for (const url of ["/api/categories", "/api/rules"]) {
      await request(ctx.app).get(url).set("Host", "127.0.0.1:47998").expect(401);
    }
  });
});

describe("rule matching", () => {
  const subject = (over: Partial<RuleSubject> = {}): RuleSubject => ({
    merchant: "Whole Foods Market",
    name: "WHOLEFDS MKT 10234",
    recipient: null,
    plaidPrimary: "FOOD_AND_DRINK",
    plaidDetailed: "FOOD_AND_DRINK_GROCERIES",
    ...over,
  });
  const rule = (field: RuleRow["field"], operator: RuleRow["operator"], matchValue: string) => ({
    field,
    operator,
    matchValue,
  });

  it("supports equals, contains, and starts-with, ignoring case and surrounding spaces", () => {
    expect(ruleMatches(rule("merchant", "equals", "  whole foods market "), subject())).toBe(true);
    expect(ruleMatches(rule("merchant", "equals", "whole foods"), subject())).toBe(false);
    expect(ruleMatches(rule("merchant", "contains", "FOODS"), subject())).toBe(true);
    expect(ruleMatches(rule("merchant", "starts_with", "whole"), subject())).toBe(true);
    expect(ruleMatches(rule("merchant", "starts_with", "foods"), subject())).toBe(false);
  });

  it("looks at the chosen field only", () => {
    expect(ruleMatches(rule("name", "contains", "wholefds"), subject())).toBe(true);
    expect(ruleMatches(rule("merchant", "contains", "wholefds"), subject())).toBe(false);
    expect(
      ruleMatches(rule("recipient", "contains", "jane"), subject({ recipient: "Jane Doe" })),
    ).toBe(true);
    expect(ruleMatches(rule("recipient", "contains", "jane"), subject())).toBe(false);
  });

  it("matches the bank's category at either level", () => {
    expect(
      ruleMatches(rule("plaid_category", "equals", "FOOD_AND_DRINK_GROCERIES"), subject()),
    ).toBe(true);
    expect(ruleMatches(rule("plaid_category", "equals", "food_and_drink"), subject())).toBe(true);
    expect(ruleMatches(rule("plaid_category", "equals", "FOOD"), subject())).toBe(false);
    expect(
      ruleMatches(rule("plaid_category", "contains", "GROCER"), subject({ plaidPrimary: null })),
    ).toBe(true);
    expect(
      ruleMatches(
        rule("plaid_category", "equals", "X"),
        subject({ plaidPrimary: null, plaidDetailed: null }),
      ),
    ).toBe(false);
  });

  it("never matches on an empty value", () => {
    expect(ruleMatches(rule("merchant", "contains", ""), subject())).toBe(false);
    expect(ruleMatches(rule("merchant", "contains", "   "), subject())).toBe(false);
  });

  it("uses the first matching rule in order", () => {
    const rows: RuleRow[] = [
      {
        id: 1,
        name: "a",
        field: "merchant",
        operator: "contains",
        matchValue: "foods",
        categoryId: 10,
        priority: 5,
        enabled: true,
      },
      {
        id: 2,
        name: "b",
        field: "merchant",
        operator: "contains",
        matchValue: "whole",
        categoryId: 20,
        priority: 1,
        enabled: true,
      },
    ];
    // The list is already in trial order (the database sorts it); the first match wins.
    expect(firstMatch([rows[1]!, rows[0]!], subject())?.categoryId).toBe(20);
    expect(firstMatch([rows[0]!, rows[1]!], subject())?.categoryId).toBe(10);
    expect(firstMatch([], subject())).toBeNull();
  });
});

describe("starting categories and rules", () => {
  let h: ReturnType<typeof makeSyncHarness>;
  beforeEach(() => {
    h = makeSyncHarness();
  });
  afterEach(() => h.cleanup());

  it("are created once, and not again after the user removes them", async () => {
    expect(seedDefaults(h.db)).toBe(true);
    expect(h.db.select({ n: count() }).from(categories).get()!.n).toBe(15);
    expect(h.db.select({ n: count() }).from(transactionRules).get()!.n).toBe(15);
    expect(
      h.db
        .select()
        .from(transactionRules)
        .all()
        .every((r) => r.priority >= 1000),
    ).toBe(true);
    expect(seedDefaults(h.db)).toBe(false);
    h.db.delete(transactionRules).run();
    expect(seedDefaults(h.db)).toBe(false);
    expect(h.db.select({ n: count() }).from(transactionRules).get()!.n).toBe(0);
  });

  it("categorize transactions that were synced before they existed", async () => {
    const { item } = await linkDemoBank(h.call);
    await h.sync.syncItem(item.id, "manual");
    const before = (await h.call("get", "/api/transactions?category=none&pageSize=1").expect(200))
      .body;
    expect(before.total).toBe(h.db.select({ n: count() }).from(transactions).get()!.n);

    seedDefaults(h.db);
    const category = async (q: string) => {
      const items = (
        await h.call("get", `/api/transactions?pageSize=200&q=${encodeURIComponent(q)}`).expect(200)
      ).body.items;
      expect(items.length).toBeGreaterThan(0);
      return new Set(
        items.map(
          (t: { category: { name: string; source: string } | null }) =>
            `${t.category?.name}/${t.category?.source}`,
        ),
      );
    };
    expect(await category("whole foods")).toEqual(new Set(["Groceries/rule"]));
    expect(await category("chipotle")).toEqual(new Set(["Dining Out/rule"]));
    expect(await category("netflix")).toEqual(new Set(["Entertainment/rule"]));
    expect(await category("shell")).toEqual(new Set(["Transportation/rule"]));
    expect(await category("amazon")).toEqual(new Set(["Shopping/rule"]));
    expect(await category("oak street")).toEqual(new Set(["Rent & Utilities/rule"]));
    expect(await category("zelle")).toEqual(new Set(["Transfers/rule"]));
    expect(await category("acme")).toEqual(new Set(["Income/rule"]));
    const none = (await h.call("get", "/api/transactions?category=none&pageSize=1").expect(200))
      .body;
    expect(none.total).toBe(0);
  });

  it("categorize new transactions during a sync", async () => {
    seedDefaults(h.db);
    const { item } = await linkDemoBank(h.call);
    await h.sync.syncItem(item.id, "manual");
    expect(
      (await h.call("get", "/api/transactions?category=none&pageSize=1").expect(200)).body.total,
    ).toBe(0);
    h.advanceDays(5);
    const run = await h.sync.syncItem(item.id, "manual");
    expect(run.added).toBeGreaterThan(0);
    expect(
      (await h.call("get", "/api/transactions?category=none&pageSize=1").expect(200)).body.total,
    ).toBe(0);
  });
});
