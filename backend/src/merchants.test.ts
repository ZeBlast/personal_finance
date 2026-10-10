import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function synced() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const bank = await linkDemoBank(h.call);
  await h.sync.syncItem(bank.item.id, "manual");
  return { h, itemId: bank.item.id };
}
type H = Awaited<ReturnType<typeof synced>>["h"];

const category = async (h: H, name: string) =>
  (await h.call("post", "/api/categories").send({ name }).expect(201)).body.id as number;
const merchants = async (h: H, query = "") =>
  (await h.call("get", `/api/merchants${query}`).expect(200)).body as {
    total: number;
    rows: Array<{
      key: string;
      merchant: string;
      transactionCount: number;
      lastDate: string;
      uncategorizedCount: number;
      categoryCount: number;
      assigned: { ruleId: number; categoryId: number; categoryName: string } | null;
    }>;
  };
const find = async (h: H, key: string) =>
  (await merchants(h, "?limit=500")).rows.find((m) => m.key === key);
const assign = (h: H, body: Record<string, unknown>) =>
  h.call("put", "/api/merchants/assignment").send(body);
const allTx = async (h: H, q: string) =>
  (await h.call("get", `/api/transactions?pageSize=200&q=${encodeURIComponent(q)}`).expect(200))
    .body.items as Array<{
    id: number;
    merchant: string;
    category: { id: number; name: string; source: string } | null;
  }>;

describe("listing merchants", () => {
  it("groups transactions by merchant with counts and the latest date", async () => {
    const { h } = await synced();
    const res = await merchants(h, "?limit=500");
    const chipotle = res.rows.find((m) => m.key === "chipotle")!;
    expect(chipotle).toMatchObject({
      merchant: expect.stringMatching(/chipotle/i),
      assigned: null,
    });
    const real = (await allTx(h, "chipotle")).length;
    expect(chipotle.transactionCount).toBe(real);
    expect(chipotle.lastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Busiest merchants first.
    const counts = res.rows.map((m) => m.transactionCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(res.total).toBe(res.rows.length);
  });

  it("treats different capitalization and spacing as one merchant", async () => {
    const { h } = await synced();
    const cash = (
      await h
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id;
    for (const merchant of ["CHIPOTLE", "  chipotle  "]) {
      await h
        .call("post", "/api/transactions")
        .send({ accountId: cash, date: "2026-09-02", merchant, amountMinor: 900, direction: "out" })
        .expect(201);
    }
    const real = (await allTx(h, "chipotle")).length;
    const row = (await merchants(h, "?limit=500")).rows.filter((m) => m.key === "chipotle");
    expect(row).toHaveLength(1);
    expect(row[0]!.transactionCount).toBe(real);
  });

  it("follows a merchant name you changed on a transaction", async () => {
    const { h } = await synced();
    const any = (await allTx(h, "amazon"))[0]!;
    await h.call("patch", `/api/transactions/${any.id}`).send({ merchant: "Chipotle" }).expect(200);
    const chipotle = (await find(h, "chipotle"))!;
    expect(chipotle.transactionCount).toBe((await allTx(h, "chipotle")).length);
  });

  it("filters by search, assignment, and category, and pages", async () => {
    const { h } = await synced();
    const dining = await category(h, "Dining");
    const fuel = await category(h, "Fuel");
    await assign(h, { merchant: "Chipotle", categoryId: dining }).expect(200);
    await assign(h, { merchant: "Shell", categoryId: fuel }).expect(200);
    expect((await merchants(h, "?q=chip")).rows.map((m) => m.key)).toEqual(["chipotle"]);
    expect((await merchants(h, "?q=CHIP")).total).toBe(1);
    expect((await merchants(h, "?assigned=assigned")).rows.map((m) => m.key).sort()).toEqual([
      "chipotle",
      "shell",
    ]);
    expect((await merchants(h, `?assigned=${dining}`)).rows.map((m) => m.key)).toEqual([
      "chipotle",
    ]);
    const unassigned = await merchants(h, "?assigned=unassigned&limit=500");
    expect(unassigned.rows.some((m) => m.assigned)).toBe(false);
    expect(unassigned.rows.map((m) => m.key)).not.toContain("chipotle");
    const all = await merchants(h, "?limit=500");
    const page = await merchants(h, "?limit=2&offset=1");
    expect(page.total).toBe(all.total);
    expect(page.rows.map((m) => m.key)).toEqual(all.rows.slice(1, 3).map((m) => m.key));
    await h.call("get", "/api/merchants?limit=0").expect(400);
    await h.call("get", "/api/merchants?assigned=nonsense").expect(400);
  });
});

describe("assigning a merchant to a category", () => {
  it("categorizes all of the merchant's transactions now", async () => {
    const { h } = await synced();
    const dining = await category(h, "Dining");
    const before = await allTx(h, "chipotle");
    expect(before.length).toBeGreaterThan(2);
    const res = (await assign(h, { merchant: "Chipotle", categoryId: dining }).expect(200)).body;
    expect(res).toMatchObject({
      transactions: before.length,
      changed: before.length,
      assigned: { categoryId: dining, categoryName: "Dining" },
    });
    for (const t of await allTx(h, "chipotle"))
      expect(t.category).toMatchObject({ name: "Dining", source: "rule" });
    const row = (await find(h, "chipotle"))!;
    expect(row).toMatchObject({
      uncategorizedCount: 0,
      categoryCount: 1,
      assigned: { categoryName: "Dining" },
    });
  });

  it("applies to the merchant's future transactions as they arrive", async () => {
    const { h, itemId } = await synced();
    const dining = await category(h, "Dining");
    await assign(h, { merchant: "Chipotle", categoryId: dining }).expect(200);
    const before = (await allTx(h, "chipotle")).length;
    h.advanceDays(60);
    await h.sync.syncItem(itemId, "manual");
    const after = await allTx(h, "chipotle");
    expect(after.length).toBeGreaterThan(before);
    for (const t of after) expect(t.category).toMatchObject({ name: "Dining" });
  });

  it("matches however the name is typed", async () => {
    const { h } = await synced();
    const dining = await category(h, "Dining");
    const res = (await assign(h, { merchant: "  CHIPOTLE ", categoryId: dining }).expect(200)).body;
    expect(res.assigned).toMatchObject({ categoryName: "Dining" });
    expect(
      (await h.call("get", "/api/rules").expect(200)).body.filter((r: { name: string }) =>
        r.name.startsWith("Merchant:"),
      ),
    ).toHaveLength(1);
  });

  it("changes the category by updating the same rule, not stacking new ones", async () => {
    const { h } = await synced();
    const a = await category(h, "Dining");
    const b = await category(h, "Treats");
    await assign(h, { merchant: "Chipotle", categoryId: a }).expect(200);
    const res = (await assign(h, { merchant: "Chipotle", categoryId: b }).expect(200)).body;
    expect(res.assigned.categoryName).toBe("Treats");
    const rules = (await h.call("get", "/api/rules").expect(200)).body.filter(
      (r: { field: string; matchValue: string }) =>
        r.field === "merchant" && r.matchValue === "Chipotle",
    );
    expect(rules).toHaveLength(1);
    for (const t of await allTx(h, "chipotle"))
      expect(t.category).toMatchObject({ name: "Treats" });
  });

  it("wins over a broader rule that was written later", async () => {
    const { h } = await synced();
    const broad = await category(h, "Misc");
    const mine = await category(h, "Dining");
    await h
      .call("post", "/api/rules")
      .send({
        name: "Chip",
        field: "merchant",
        operator: "contains",
        matchValue: "chip",
        categoryId: broad,
      })
      .expect(201);
    await assign(h, { merchant: "Chipotle", categoryId: mine }).expect(200);
    for (const t of await allTx(h, "chipotle"))
      expect(t.category).toMatchObject({ name: "Dining" });
    // And again after the broad rule is made the newest.
    await h
      .call("post", "/api/rules")
      .send({
        name: "Chip 2",
        field: "merchant",
        operator: "contains",
        matchValue: "chipotle",
        categoryId: broad,
      })
      .expect(201);
    await assign(h, { merchant: "Chipotle", categoryId: mine }).expect(200);
    for (const t of await allTx(h, "chipotle"))
      expect(t.category).toMatchObject({ name: "Dining" });
  });

  it("removes the assignment, handing transactions back to the other rules", async () => {
    const { h } = await synced();
    const dining = await category(h, "Dining");
    await assign(h, { merchant: "Chipotle", categoryId: dining }).expect(200);
    const res = (await assign(h, { merchant: "Chipotle", categoryId: null }).expect(200)).body;
    expect(res).toMatchObject({ assigned: null });
    expect(res.changed).toBeGreaterThan(0);
    for (const t of await allTx(h, "chipotle")) expect(t.category).toBeNull();
    expect(
      (await h.call("get", "/api/rules").expect(200)).body.filter((r: { name: string }) =>
        r.name.startsWith("Merchant:"),
      ),
    ).toHaveLength(0);
    // Removing it again is harmless.
    await assign(h, { merchant: "Chipotle", categoryId: null }).expect(200);
  });

  it("leaves categories you picked on a single transaction, unless asked to replace them", async () => {
    const { h } = await synced();
    const dining = await category(h, "Dining");
    const mine = await category(h, "Special");
    const [first, ...rest] = await allTx(h, "chipotle");
    await h.call("patch", `/api/transactions/${first!.id}`).send({ categoryId: mine }).expect(200);
    await assign(h, { merchant: "Chipotle", categoryId: dining }).expect(200);
    expect(
      (await h.call("get", `/api/transactions/${first!.id}`).expect(200)).body.category,
    ).toMatchObject({ name: "Special", source: "manual" });
    for (const t of await allTx(h, "chipotle")) {
      if (t.id !== first!.id) expect(t.category).toMatchObject({ name: "Dining" });
    }
    expect((await find(h, "chipotle"))!.categoryCount).toBe(2); // mixed, and the page can say so
    const res = (
      await assign(h, { merchant: "Chipotle", categoryId: dining, overrideManual: true }).expect(
        200,
      )
    ).body;
    expect(res.changed).toBe(1);
    expect(
      (await h.call("get", `/api/transactions/${first!.id}`).expect(200)).body.category,
    ).toMatchObject({ name: "Dining", source: "rule" });
    expect(rest.length).toBeGreaterThan(0);
  });

  it("refuses unknown merchants, blank names, and unusable categories, changing nothing", async () => {
    const { h } = await synced();
    const dining = await category(h, "Dining");
    const archived = await category(h, "Old");
    await assign(h, { merchant: "Chipotle", categoryId: dining }).expect(200);
    await assign(h, { merchant: "No Such Merchant", categoryId: dining }).expect(404);
    await assign(h, { merchant: "   ", categoryId: dining }).expect(400);
    await assign(h, { merchant: "Chipotle", categoryId: 99999 }).expect(400);
    // Archiving needs the category to be unused: park a transaction there first, then archive it.
    const any = (await allTx(h, "amazon"))[0]!;
    await h.call("patch", `/api/transactions/${any.id}`).send({ categoryId: archived }).expect(200);
    await h.call("delete", `/api/categories/${archived}`).expect(200); // archives, since it is in use
    const refused = await assign(h, { merchant: "Chipotle", categoryId: archived }).expect(400);
    expect(refused.body.error).toBe("inactive_category");
    // The earlier assignment is untouched.
    expect((await find(h, "chipotle"))!.assigned).toMatchObject({ categoryName: "Dining" });
    await assign(h, { merchant: "Chipotle", categoryId: dining, extra: 1 }).expect(400);
  });

  it("works for merchants entered by hand", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const cash = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id;
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: cash,
        date: "2026-09-02",
        merchant: "Corner Cafe",
        amountMinor: 450,
        direction: "out",
      })
      .expect(201);
    const dining = (await t.call("post", "/api/categories").send({ name: "Dining" }).expect(201))
      .body.id;
    const res = (
      await t
        .call("put", "/api/merchants/assignment")
        .send({ merchant: "Corner Cafe", categoryId: dining })
        .expect(200)
    ).body;
    expect(res).toMatchObject({ transactions: 1, changed: 1 });
    // A new cash purchase at the same place is categorized on entry.
    const next = (
      await t
        .call("post", "/api/transactions")
        .send({
          accountId: cash,
          date: "2026-09-05",
          merchant: "corner cafe",
          amountMinor: 500,
          direction: "out",
        })
        .expect(201)
    ).body;
    expect(next.category).toMatchObject({ name: "Dining", source: "rule" });
  });
});

describe("one merchant, many spellings", () => {
  it("matches the same place whatever the store number or capitalization", async () => {
    const { ruleMatches } = await import("./services/rule.service.js");
    const rule = { field: "merchant", operator: "same_merchant", matchValue: "Chipotle" } as const;
    const subject = (merchant: string) => ({
      merchant,
      name: merchant,
      recipient: null,
      sender: null,
      plaidPrimary: null,
      plaidDetailed: null,
    });
    for (const same of [
      "Chipotle",
      "CHIPOTLE 2041",
      "chipotle #1999",
      "  Chipotle  ",
      "CHIPOTLE*8841",
    ]) {
      expect(ruleMatches(rule, subject(same)), same).toBe(true);
    }
    for (const other of ["Chipotle Mexican Grill", "Chip", "Pizza Hut 2041", "2041"]) {
      expect(ruleMatches(rule, subject(other)), other).toBe(false);
    }
    expect(ruleMatches({ ...rule, matchValue: "12345" }, subject("12345"))).toBe(false);
    expect(ruleMatches({ ...rule, matchValue: " " }, subject("Chipotle"))).toBe(false);
  });

  it("lists spellings as one merchant, categorizes them all, and catches new spellings later", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const cash = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id;
    const add = (merchant: string, date: string) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId: cash, date, merchant, amountMinor: 900, direction: "out" })
        .expect(201);
    await add("Chipotle", "2026-09-01");
    await add("CHIPOTLE 2041", "2026-09-05");
    await add("Chipotle #1999", "2026-09-03");
    const list = (await t.call("get", "/api/merchants").expect(200)).body;
    expect(list.rows).toHaveLength(1);
    // Shown under the spelling of the most recent transaction.
    expect(list.rows[0]).toMatchObject({
      key: "chipotle",
      merchant: "CHIPOTLE 2041",
      transactionCount: 3,
      lastDate: "2026-09-05",
      uncategorizedCount: 3,
    });

    const dining = (await t.call("post", "/api/categories").send({ name: "Dining" }).expect(201))
      .body.id;
    const res = (
      await t
        .call("put", "/api/merchants/assignment")
        .send({ merchant: "Chipotle", categoryId: dining })
        .expect(200)
    ).body;
    expect(res).toMatchObject({ transactions: 3, changed: 3 });
    const rules = (await t.call("get", "/api/rules").expect(200)).body.filter(
      (r: { name: string }) => r.name.startsWith("Merchant:"),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ operator: "same_merchant", matchValue: "Chipotle" });

    // A spelling nobody has seen yet is caught as it arrives.
    const later = (await add("CHIPOTLE 7788", "2026-09-10")).body;
    expect(later.category).toMatchObject({ name: "Dining", source: "rule" });
    expect((await t.call("get", "/api/merchants").expect(200)).body.rows[0]).toMatchObject({
      transactionCount: 4,
      uncategorizedCount: 0,
      categoryCount: 1,
    });
  });

  it("accepts the new rule type through the rules API too", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const cat = (await t.call("post", "/api/categories").send({ name: "Dining" }).expect(201)).body
      .id;
    const made = await t
      .call("post", "/api/rules")
      .send({
        name: "Same as Starbucks",
        field: "merchant",
        operator: "same_merchant",
        matchValue: "Starbucks",
        categoryId: cat,
      })
      .expect(201);
    expect(made.body.operator).toBe("same_merchant");
    await t
      .call("post", "/api/rules")
      .send({
        name: "x",
        field: "merchant",
        operator: "sounds_like",
        matchValue: "Starbucks",
        categoryId: cat,
      })
      .expect(400);
  });
});
