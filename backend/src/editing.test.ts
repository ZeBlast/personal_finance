import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accounts, creditLimitHistory, plaidItems, transactions } from "../../drizzle/schema.js";
import { seedDefaults } from "./services/category.service.js";
import { linkDemoBank, makeSyncHarness } from "./test-helpers.js";

type H = ReturnType<typeof makeSyncHarness>;
let h: H;
let itemId: number;

beforeEach(async () => {
  h = makeSyncHarness();
  itemId = (await linkDemoBank(h.call)).item.id;
  await h.sync.syncItem(itemId, "manual");
});
afterEach(() => h.cleanup());

const category = async (name: string, extra: Record<string, unknown> = {}) =>
  (
    await h
      .call("post", "/api/categories")
      .send({ name, ...extra })
      .expect(201)
  ).body as { id: number; name: string };

const rule = async (body: Record<string, unknown>) =>
  (await h.call("post", "/api/rules").send(body).expect(201)).body as {
    id: number;
    priority: number;
    categoryName: string;
  };

const list = async (query = "") =>
  (await h.call("get", `/api/transactions?pageSize=200${query ? `&${query}` : ""}`).expect(200))
    .body as {
    // Test-only: the JSON is checked field by field below, so loose typing keeps the tests readable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: Array<Record<string, any>>;
    total: number;
  };

const firstTx = async (q: string) => {
  const items = (await list(`q=${encodeURIComponent(q)}`)).items;
  expect(items.length).toBeGreaterThan(0);
  return items[0]!;
};

describe("editing many transactions at once", () => {
  it("sets one category on all of them, as the user's own choice", async () => {
    const mine = await category("Mine");
    const ids = (await list()).items.slice(0, 3).map((t) => t.id as number);
    const res = await h
      .call("post", "/api/transactions/bulk")
      .send({ ids, categoryId: mine.id })
      .expect(200);
    expect(res.body).toEqual({ updated: 3 });
    for (const id of ids) {
      const t = (await h.call("get", `/api/transactions/${id}`).expect(200)).body;
      expect(t.category).toMatchObject({ id: mine.id, source: "manual" });
    }
  });

  it("changes none of them when one cannot be changed", async () => {
    const mine = await category("Mine");
    const [a, b] = (await list()).items.map((t) => t.id as number);
    const before = (await h.call("get", `/api/transactions/${a}`).expect(200)).body.category;
    await h
      .call("post", "/api/transactions/bulk")
      .send({ ids: [a, b, 999999], categoryId: mine.id })
      .expect(404);
    expect((await h.call("get", `/api/transactions/${a}`).expect(200)).body.category).toEqual(
      before,
    );
    await h
      .call("post", "/api/transactions/bulk")
      .send({ ids: [a] })
      .expect(400);
    await h.call("post", "/api/transactions/bulk").send({ ids: [], categoryId: null }).expect(400);
  });

  it("marks them as transfers, and hands them back to the app's matching", async () => {
    const ids = (await list("q=whole%20foods")).items.slice(0, 2).map((t) => t.id as number);
    await h.call("post", "/api/transactions/bulk").send({ ids, isTransfer: true }).expect(200);
    for (const id of ids) {
      const t = (await h.call("get", `/api/transactions/${id}`).expect(200)).body;
      expect(t.isTransfer).toBe(true);
    }
    await h.call("post", "/api/transactions/bulk").send({ ids, isTransfer: null }).expect(200);
    for (const id of ids) {
      const t = (await h.call("get", `/api/transactions/${id}`).expect(200)).body;
      expect(t.isTransfer).toBe(false);
    }
  });
});

describe("editing a transaction", () => {
  it("sets a category by hand, which rules then leave alone", async () => {
    const mine = await category("Mine");
    const t = await firstTx("whole foods");
    const res = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ categoryId: mine.id }).expect(200)
    ).body;
    expect(res.category).toMatchObject({
      id: mine.id,
      name: "Mine",
      source: "manual",
      ruleName: null,
    });

    // A rule that would match it does not change a hand-picked category, even when applied.
    const other = await category("Other");
    await rule({
      name: "r",
      field: "merchant",
      operator: "contains",
      matchValue: "whole foods",
      categoryId: other.id,
    });
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await h.call("get", `/api/transactions/${t.id}`).expect(200)).body.category.id).toBe(
      mine.id,
    );
  });

  it("clearing a hand-picked category hands the transaction back to the rules", async () => {
    seedDefaults(h.db);
    const mine = await category("Mine");
    const t = await firstTx("whole foods");
    await h.call("patch", `/api/transactions/${t.id}`).send({ categoryId: mine.id }).expect(200);
    const res = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ categoryId: null }).expect(200)
    ).body;
    expect(res.category).toMatchObject({ name: "Groceries", source: "rule" });
  });

  it("clearing the category with no rule match leaves it uncategorized", async () => {
    const mine = await category("Mine");
    const t = await firstTx("whole foods");
    await h.call("patch", `/api/transactions/${t.id}`).send({ categoryId: mine.id }).expect(200);
    const res = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ categoryId: null }).expect(200)
    ).body;
    expect(res.category).toBeNull();
  });

  it("changes the merchant name shown, remembers the bank's, and reverts when blanked", async () => {
    const t = await firstTx("whole foods");
    const edited = (
      await h
        .call("patch", `/api/transactions/${t.id}`)
        .send({ merchant: "  My Grocer  " })
        .expect(200)
    ).body;
    expect(edited).toMatchObject({
      merchant: "My Grocer",
      merchantEdited: true,
      providerMerchant: t.providerMerchant,
    });
    const reverted = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ merchant: "   " }).expect(200)
    ).body;
    expect(reverted).toMatchObject({ merchant: t.providerMerchant, merchantEdited: false });
    expect(
      (await h.call("patch", `/api/transactions/${t.id}`).send({ merchant: "Again" }).expect(200))
        .body.merchant,
    ).toBe("Again");
    expect(
      (await h.call("patch", `/api/transactions/${t.id}`).send({ merchant: null }).expect(200)).body
        .merchantEdited,
    ).toBe(false);
  });

  it("overrides and restores a recipient, keeping the detected one for reference", async () => {
    const t = await firstTx("zelle payment to");
    expect(t).toMatchObject({ recipient: "Jane Doe", recipientSource: "parsed" });
    const edited = (
      await h
        .call("patch", `/api/transactions/${t.id}`)
        .send({ recipient: "Janet Doe" })
        .expect(200)
    ).body;
    expect(edited).toMatchObject({
      recipient: "Janet Doe",
      recipientSource: "manual",
      providerRecipient: "Jane Doe",
    });
    // A recipient can also be added to a transaction where none was detected.
    const plain = await firstTx("chipotle");
    expect(
      (
        await h
          .call("patch", `/api/transactions/${plain.id}`)
          .send({ recipient: "Dinner with Sam" })
          .expect(200)
      ).body,
    ).toMatchObject({ recipient: "Dinner with Sam", recipientSource: "manual" });
    const back = (
      await h.call("patch", `/api/transactions/${t.id}`).send({ recipient: "" }).expect(200)
    ).body;
    expect(back).toMatchObject({ recipient: "Jane Doe", recipientSource: "parsed" });
  });

  it("stores and clears notes", async () => {
    const t = await firstTx("netflix");
    expect(
      (
        await h
          .call("patch", `/api/transactions/${t.id}`)
          .send({ notes: " shared with Sam " })
          .expect(200)
      ).body.notes,
    ).toBe("shared with Sam");
    expect(
      (await h.call("patch", `/api/transactions/${t.id}`).send({ notes: "" }).expect(200)).body
        .notes,
    ).toBeNull();
  });

  it("changes several fields at once", async () => {
    const mine = await category("Mine");
    const t = await firstTx("netflix");
    const res = (
      await h
        .call("patch", `/api/transactions/${t.id}`)
        .send({ categoryId: mine.id, notes: "n", merchant: "NF" })
        .expect(200)
    ).body;
    expect(res).toMatchObject({ merchant: "NF", notes: "n", category: { id: mine.id } });
  });

  it("only allows the user-editable fields", async () => {
    const t = await firstTx("netflix");
    // Fields only a transaction entered by hand may change: refused, with a clear reason.
    for (const body of [{ amountMinor: 1 }, { date: "2020-01-01" }, { pending: true }]) {
      const res = await h.call("patch", `/api/transactions/${t.id}`).send(body).expect(409);
      expect(res.body.error).toBe("bank_transaction");
    }
    // Anything else is simply not a field.
    for (const body of [{ name: "x" }, {}]) {
      await h.call("patch", `/api/transactions/${t.id}`).send(body).expect(400);
    }
    expect((await h.call("get", `/api/transactions/${t.id}`).expect(200)).body).toMatchObject({
      amountMinor: t.amountMinor,
      date: t.date,
      name: t.name,
    });
  });

  it("rejects unknown, archived, and malformed targets", async () => {
    const t = await firstTx("netflix");
    await h.call("patch", "/api/transactions/99999").send({ notes: "x" }).expect(404);
    await h.call("patch", "/api/transactions/abc").send({ notes: "x" }).expect(400);
    expect(
      (await h.call("patch", `/api/transactions/${t.id}`).send({ categoryId: 99999 }).expect(400))
        .body.error,
    ).toBe("unknown_category");
    const archived = await category("Gone");
    await h.call("patch", `/api/categories/${archived.id}`).send({ active: false }).expect(200);
    expect(
      (
        await h
          .call("patch", `/api/transactions/${t.id}`)
          .send({ categoryId: archived.id })
          .expect(400)
      ).body.error,
    ).toBe("inactive_category");
    await h
      .call("patch", `/api/transactions/${t.id}`)
      .send({ notes: "x".repeat(2001) })
      .expect(400);
    await h
      .call("patch", `/api/transactions/${t.id}`)
      .send({ merchant: "x".repeat(201) })
      .expect(400);
    await h
      .call("patch", `/api/transactions/${t.id}`)
      .send({ recipient: "x".repeat(101) })
      .expect(400);
    await h.call("get", "/api/transactions/99999").expect(404);
  });

  it("keeps every edit through later syncs, including a pending transaction that posts", async () => {
    const mine = await category("Mine");
    const pending = (await list("pending=true")).items[0]!;
    await h
      .call("patch", `/api/transactions/${pending.id}`)
      .send({ categoryId: mine.id, notes: "keep me", merchant: "Mine Co", recipient: "Pat" })
      .expect(200);
    const zelle = await firstTx("zelle payment to");
    await h.call("patch", `/api/transactions/${zelle.id}`).send({ recipient: "Janet" }).expect(200);

    h.advanceDays(8);
    await h.sync.syncItem(itemId, "manual");

    const after = (await h.call("get", `/api/transactions/${pending.id}`).expect(200)).body;
    expect(after).toMatchObject({
      pending: false,
      notes: "keep me",
      merchant: "Mine Co",
      recipient: "Pat",
      category: { id: mine.id, source: "manual" },
    });
    expect((await h.call("get", `/api/transactions/${zelle.id}`).expect(200)).body.recipient).toBe(
      "Janet",
    );
  });

  it("re-evaluates the rules after a merchant edit, unless the category is manual", async () => {
    const landlord = await category("Landlord");
    await rule({
      name: "L",
      field: "merchant",
      operator: "equals",
      matchValue: "My Landlord",
      categoryId: landlord.id,
    });
    const t = await firstTx("oak street");
    expect(t.category).toBeNull();
    const res = (
      await h
        .call("patch", `/api/transactions/${t.id}`)
        .send({ merchant: "my landlord" })
        .expect(200)
    ).body;
    expect(res.category).toMatchObject({ id: landlord.id, source: "rule", ruleName: "L" });
    // Back to the bank's merchant: the rule no longer matches, so the category goes away again.
    expect(
      (await h.call("patch", `/api/transactions/${t.id}`).send({ merchant: null }).expect(200)).body
        .category,
    ).toBeNull();
  });
});

describe("rules", () => {
  it("validates a rule", async () => {
    const c = await category("C");
    const ok = {
      name: "n",
      field: "merchant",
      operator: "contains",
      matchValue: "x",
      categoryId: c.id,
    };
    for (const bad of [
      { ...ok, name: "" },
      { ...ok, field: "amount" },
      { ...ok, operator: "regex" },
      { ...ok, matchValue: "   " },
      { ...ok, matchValue: "x".repeat(201) },
      { ...ok, extra: 1 },
      { name: "n" },
    ]) {
      await h.call("post", "/api/rules").send(bad).expect(400);
    }
    expect(
      (
        await h
          .call("post", "/api/rules")
          .send({ ...ok, categoryId: 999 })
          .expect(400)
      ).body.error,
    ).toBe("unknown_category");
    await h.call("patch", `/api/categories/${c.id}`).send({ active: false }).expect(200);
    expect((await h.call("post", "/api/rules").send(ok).expect(400)).body.error).toBe(
      "inactive_category",
    );
  });

  it("puts a new rule above existing ones so the latest rule wins", async () => {
    seedDefaults(h.db);
    const before = (await h.call("get", "/api/rules").expect(200)).body as Array<{
      priority: number;
    }>;
    const c = await category("Online Orders");
    const created = await rule({
      name: "Amazon",
      field: "merchant",
      operator: "contains",
      matchValue: "amazon",
      categoryId: c.id,
    });
    expect(created.priority).toBeLessThan(Math.min(...before.map((r) => r.priority)));
    const rules = (await h.call("get", "/api/rules").expect(200)).body;
    expect(rules[0].id).toBe(created.id);
  });

  it("applies to new transactions automatically but to existing ones only on request", async () => {
    seedDefaults(h.db);
    const orders = await category("Online Orders");
    const before = await firstTx("amazon");
    expect(before.category.name).toBe("Shopping");

    await rule({
      name: "Amazon",
      field: "merchant",
      operator: "contains",
      matchValue: "amazon",
      categoryId: orders.id,
    });
    expect(
      (await h.call("get", `/api/transactions/${before.id}`).expect(200)).body.category.name,
    ).toBe("Shopping"); // not yet

    const applied = (await h.call("post", "/api/rules/apply").send({}).expect(200)).body;
    expect(applied.changed).toBeGreaterThan(0);
    expect(
      (await h.call("get", `/api/transactions/${before.id}`).expect(200)).body.category,
    ).toMatchObject({ name: "Online Orders", source: "rule" });

    // Running it again changes nothing.
    expect((await h.call("post", "/api/rules/apply").send({}).expect(200)).body.changed).toBe(0);

    // New transactions get it during sync.
    h.advanceDays(10);
    await h.sync.syncItem(itemId, "manual");
    const amazon = (await list("q=amazon")).items;
    expect(amazon.every((t) => t.category?.name === "Online Orders")).toBe(true);
  });

  it("returns a transaction to uncategorized when its rule is disabled or edited to no longer match", async () => {
    const c = await category("Pizza");
    const r = await rule({
      name: "Chipotle",
      field: "merchant",
      operator: "contains",
      matchValue: "chipotle",
      categoryId: c.id,
    });
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await list("q=chipotle")).items.every((t) => t.category?.id === c.id)).toBe(true);

    await h.call("patch", `/api/rules/${r.id}`).send({ enabled: false }).expect(200);
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await list("q=chipotle")).items.every((t) => t.category === null)).toBe(true);

    await h
      .call("patch", `/api/rules/${r.id}`)
      .send({ enabled: true, matchValue: "burrito" })
      .expect(200);
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await list("q=chipotle")).items.every((t) => t.category === null)).toBe(true);
  });

  it("ignores rules whose category is archived", async () => {
    const c = await category("Pizza");
    await rule({
      name: "Chipotle",
      field: "merchant",
      operator: "contains",
      matchValue: "chipotle",
      categoryId: c.id,
    });
    await h.call("patch", `/api/categories/${c.id}`).send({ active: false }).expect(200);
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await list("q=chipotle")).items.every((t) => t.category === null)).toBe(true);
  });

  it("deleting a rule re-evaluates what it had categorized, with no dangling references", async () => {
    seedDefaults(h.db);
    const orders = await category("Online Orders");
    const r = await rule({
      name: "Amazon",
      field: "merchant",
      operator: "contains",
      matchValue: "amazon",
      categoryId: orders.id,
    });
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await firstTx("amazon")).category.name).toBe("Online Orders");

    await h.call("delete", `/api/rules/${r.id}`).expect(204);
    const after = (await list("q=amazon")).items;
    expect(
      after.every((t) => t.category?.name === "Shopping" && t.category.source === "rule"),
    ).toBe(true); // the built-in rule takes over
    expect(
      h.db
        .select()
        .from(transactions)
        .all()
        .every((t) => t.categoryRuleId !== r.id),
    ).toBe(true);
    await h.call("delete", `/api/rules/${r.id}`).expect(404);
  });

  it("edits a rule's fields and rejects bad edits", async () => {
    const c = await category("C");
    const d = await category("D");
    const r = await rule({
      name: "n",
      field: "merchant",
      operator: "contains",
      matchValue: "x",
      categoryId: c.id,
    });
    const edited = (
      await h
        .call("patch", `/api/rules/${r.id}`)
        .send({ name: "New", operator: "equals", categoryId: d.id })
        .expect(200)
    ).body;
    expect(edited).toMatchObject({
      name: "New",
      operator: "equals",
      categoryId: d.id,
      categoryName: "D",
    });
    await h.call("patch", `/api/rules/${r.id}`).send({}).expect(400);
    await h.call("patch", `/api/rules/${r.id}`).send({ operator: "regex" }).expect(400);
    await h.call("patch", "/api/rules/999").send({ name: "x" }).expect(404);
  });

  it("reorders rules, and the new order decides the winner", async () => {
    const a = await category("A");
    const b = await category("B");
    const r1 = await rule({
      name: "first",
      field: "merchant",
      operator: "contains",
      matchValue: "chipotle",
      categoryId: a.id,
    });
    const r2 = await rule({
      name: "second",
      field: "merchant",
      operator: "contains",
      matchValue: "chip",
      categoryId: b.id,
    });
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await firstTx("chipotle")).category.name).toBe("B"); // r2 was created last, so it is on top

    const reordered = (
      await h
        .call("post", "/api/rules/reorder")
        .send({ orderedIds: [r1.id, r2.id] })
        .expect(200)
    ).body;
    expect(reordered.map((r: { id: number }) => r.id)).toEqual([r1.id, r2.id]);
    await h.call("post", "/api/rules/apply").send({}).expect(200);
    expect((await firstTx("chipotle")).category.name).toBe("A");
  });

  it("insists a new order lists every rule exactly once", async () => {
    const c = await category("C");
    const r1 = await rule({
      name: "1",
      field: "merchant",
      operator: "contains",
      matchValue: "a",
      categoryId: c.id,
    });
    const r2 = await rule({
      name: "2",
      field: "merchant",
      operator: "contains",
      matchValue: "b",
      categoryId: c.id,
    });
    for (const orderedIds of [[r1.id], [r1.id, r1.id], [r1.id, r2.id, 999], [r1.id, 999], []]) {
      expect(
        (await h.call("post", "/api/rules/reorder").send({ orderedIds }).expect(400)).body.error,
      ).toBe("invalid_order");
    }
    await h.call("post", "/api/rules/reorder").send({}).expect(400);
  });

  it("previews how many existing transactions a rule would match", async () => {
    const preview = (
      await h
        .call("post", "/api/rules/preview")
        .send({ field: "merchant", operator: "contains", matchValue: "amazon" })
        .expect(200)
    ).body;
    const real = (await list("q=amazon")).total;
    expect(preview.matchCount).toBe(real);
    expect(preview.sample.length).toBe(Math.min(5, real));
    expect(preview.sample[0]).toMatchObject({ merchant: expect.stringMatching(/amazon/i) });
    const dates = preview.sample.map((s: { date: string }) => s.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(
      (
        await h
          .call("post", "/api/rules/preview")
          .send({ field: "merchant", operator: "contains", matchValue: "zzzzz" })
          .expect(200)
      ).body,
    ).toEqual({ matchCount: 0, sample: [] });
    await h.call("post", "/api/rules/preview").send({ field: "merchant" }).expect(400);
  });
});

describe("listing, filtering and sorting", () => {
  beforeEach(() => {
    seedDefaults(h.db);
  });

  it("filters by category, including subcategories, and by uncategorized", async () => {
    const parent = await category("Food");
    const kid = await category("Takeout", { parentId: parent.id });
    const chipotle = await firstTx("chipotle");
    await h
      .call("patch", `/api/transactions/${chipotle.id}`)
      .send({ categoryId: kid.id })
      .expect(200);

    const byKid = await list(`category=${kid.id}`);
    expect(byKid.items.map((t) => t.id)).toEqual([chipotle.id]);
    const byParent = await list(`category=${parent.id}`);
    expect(byParent.items.map((t) => t.id)).toEqual([chipotle.id]); // a parent includes its subcategories

    await h
      .call("patch", `/api/transactions/${chipotle.id}`)
      .send({ categoryId: null })
      .expect(200);
    h.db
      .update(transactions)
      .set({ categoryId: null, categorySource: null, categoryRuleId: null })
      .where(eq(transactions.id, chipotle.id))
      .run();
    const none = await list("category=none");
    expect(none.items.map((t) => t.id)).toContain(chipotle.id);
    expect(none.items.every((t) => t.category === null)).toBe(true);
    await h.call("get", "/api/transactions?category=abc").expect(400);
  });

  it("finds transactions by category name, and combines filters", async () => {
    const groceries = await list("q=groceries");
    expect(groceries.items.length).toBeGreaterThan(0);
    expect(groceries.items.every((t) => t.category?.name === "Groceries")).toBe(true);

    const checking = h.db.select().from(accounts).where(eq(accounts.subtype, "checking")).get()!;
    const combined = await list(
      `q=groceries&accountId=${checking.id}&pending=false&from=2026-08-01&to=2026-08-31`,
    );
    expect(combined.items.length).toBeGreaterThan(0);
    for (const t of combined.items) {
      expect(t.accountId).toBe(checking.id);
      expect(t.pending).toBe(false);
      expect(t.date >= "2026-08-01" && t.date <= "2026-08-31").toBe(true);
      expect(t.category.name).toBe("Groceries");
    }
    expect((await list("q=groceries&accountId=999999")).total).toBe(0);
  });

  it("sorts by date, amount as people read it, and merchant", async () => {
    const dates = (await list("sort=date_asc")).items.map((t) => t.date);
    expect(dates).toEqual([...dates].sort());
    expect((await list("sort=date_desc")).items.map((t) => t.date)).toEqual(
      [...dates].sort().reverse(),
    );

    // Biggest spending first: the largest positive amount_minor (money out) comes first.
    const spendingFirst = (await list("sort=amount_asc")).items.map((t) => t.amountMinor);
    expect(spendingFirst).toEqual([...spendingFirst].sort((a, b) => b - a));
    expect(spendingFirst[0]).toBeGreaterThan(0);
    // Money in first.
    const incomeFirst = (await list("sort=amount_desc")).items.map((t) => t.amountMinor);
    expect(incomeFirst).toEqual([...incomeFirst].sort((a, b) => a - b));
    expect(incomeFirst[0]).toBeLessThan(0);

    const merchants = (await list("sort=merchant_asc")).items.map((t) =>
      (t.merchant as string).toLowerCase(),
    );
    expect(merchants).toEqual([...merchants].sort());
    expect(
      (await list("sort=merchant_desc")).items.map((t) => (t.merchant as string).toLowerCase()),
    ).toEqual([...merchants].sort().reverse());
    await h.call("get", "/api/transactions?sort=sideways").expect(400);
  });

  it("sorts by the merchant the user sees, including their own edits", async () => {
    const t = await firstTx("netflix");
    await h.call("patch", `/api/transactions/${t.id}`).send({ merchant: "AAA First" }).expect(200);
    expect((await list("sort=merchant_asc")).items[0]!.id).toBe(t.id);
  });

  it("paginates consistently under any sort", async () => {
    const all = (await list("sort=amount_asc")).items.map((t) => t.id);
    const first = (
      await h.call("get", "/api/transactions?pageSize=40&page=1&sort=amount_asc").expect(200)
    ).body.items.map((t: { id: number }) => t.id);
    const second = (
      await h.call("get", "/api/transactions?pageSize=40&page=2&sort=amount_asc").expect(200)
    ).body.items.map((t: { id: number }) => t.id);
    expect([...first, ...second]).toEqual(all.slice(0, 80));
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  });

  it("describes the category source in the listing", async () => {
    const t = await firstTx("whole foods");
    expect(t.category).toMatchObject({ name: "Groceries", source: "rule", active: true });
    expect(t.category.ruleName).toContain("FOOD_AND_DRINK_GROCERIES");
    expect(t.category.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("credit limits entered by hand", () => {
  const cardId = () =>
    h.db.select().from(accounts).where(eq(accounts.subtype, "credit card")).get()!.id;
  const checkingId = () =>
    h.db.select().from(accounts).where(eq(accounts.subtype, "checking")).get()!.id;
  const view = async () =>
    (await h.call("get", `/api/accounts/${cardId()}/credit-limits`).expect(200)).body;
  const add = (body: Record<string, unknown>, expected = 201) =>
    h.call("post", `/api/accounts/${cardId()}/credit-limits`).send(body).expect(expected);

  it("adds a backdated entry and recalculates every change figure in date order", async () => {
    // The sync already observed $2,000 dated 2026-09-01.
    const res = (
      await add({ limitMinor: 100000, effectiveDate: "2026-03-15", note: "  first card limit  " })
    ).body;
    expect(res.entries.map((e: { effectiveDate: string }) => e.effectiveDate)).toEqual([
      "2026-09-01",
      "2026-03-15",
    ]);
    expect(res.entries[1]).toMatchObject({
      limitMinor: 100000,
      source: "manual",
      note: "first card limit",
      changeMinor: null,
      changePercent: null,
    });
    expect(res.entries[0]).toMatchObject({
      limitMinor: 200000,
      source: "plaid",
      changeMinor: 100000,
      changePercent: 100,
    });
    expect(res.current).toMatchObject({ limitMinor: 200000, effectiveDate: "2026-09-01" });

    await add({ limitMinor: 150000, effectiveDate: "2026-06-01" });
    const full = await view();
    expect(full.entries.map((e: { limitMinor: number }) => e.limitMinor)).toEqual([
      200000, 150000, 100000,
    ]);
    expect(full.entries[0]).toMatchObject({ changeMinor: 50000, changePercent: 33.3 });
    expect(full.entries[1]).toMatchObject({ changeMinor: 50000, changePercent: 50 });
  });

  it("records decreases, and the account shows the current limit", async () => {
    await add({ limitMinor: 120000, effectiveDate: "2026-09-10" });
    const res = await view();
    // 2026-09-10 is after the observed one on 09-01, but the test clock is in the past relative
    // to the real date, so it counts as already in effect.
    expect(res.entries[0]).toMatchObject({
      limitMinor: 120000,
      changeMinor: -80000,
      changePercent: -40,
    });
    const accountsRes = (await h.call("get", "/api/accounts").expect(200)).body;
    expect(accountsRes.find((a: { id: number }) => a.id === cardId()).creditLimitMinor).toBe(
      120000,
    );
  });

  it("treats an entry dated in the future as scheduled, not current", async () => {
    await add({ limitMinor: 500000, effectiveDate: "2999-01-01" });
    const res = await view();
    expect(res.current.limitMinor).toBe(200000);
    expect(res.entries[0]).toMatchObject({ limitMinor: 500000, effectiveDate: "2999-01-01" });
  });

  it("breaks ties between same-day entries by the order they were added", async () => {
    await add({ limitMinor: 111100, effectiveDate: "2026-09-01" });
    await add({ limitMinor: 222200, effectiveDate: "2026-09-01" });
    expect((await view()).current.limitMinor).toBe(222200);
  });

  it("rejects bad entries", async () => {
    for (const bad of [
      { limitMinor: 0, effectiveDate: "2026-01-01" },
      { limitMinor: -5, effectiveDate: "2026-01-01" },
      { limitMinor: 10.5, effectiveDate: "2026-01-01" },
      { limitMinor: 1e12, effectiveDate: "2026-01-01" },
      { limitMinor: 100, effectiveDate: "yesterday" },
      { limitMinor: 100, effectiveDate: "2026-02-31" },
      { limitMinor: 100, effectiveDate: "2026-13-01" },
      { limitMinor: 100 },
      { effectiveDate: "2026-01-01" },
      { limitMinor: 100, effectiveDate: "2026-01-01", note: "x".repeat(201) },
      { limitMinor: 100, effectiveDate: "2026-01-01", extra: true },
    ]) {
      await add(bad, 400);
    }
    expect(h.db.select().from(creditLimitHistory).all()).toHaveLength(1); // only the observed one
  });

  it("only allows credit accounts, and known accounts", async () => {
    const res = await h
      .call("post", `/api/accounts/${checkingId()}/credit-limits`)
      .send({ limitMinor: 100, effectiveDate: "2026-01-01" })
      .expect(400);
    expect(res.body.error).toBe("not_credit_account");
    await h
      .call("post", "/api/accounts/99999/credit-limits")
      .send({ limitMinor: 100, effectiveDate: "2026-01-01" })
      .expect(404);
  });

  it("edits the amount, which makes the entry the user's own", async () => {
    const observed = (await view()).entries[0];
    const res = (
      await h
        .call("patch", `/api/credit-limits/${observed.id}`)
        .send({ limitMinor: 250000 })
        .expect(200)
    ).body;
    expect(res.entries[0]).toMatchObject({ id: observed.id, limitMinor: 250000, source: "manual" });
    expect(res.current.limitMinor).toBe(250000);
  });

  it("editing only the date or note keeps an observed entry observed", async () => {
    const observed = (await view()).entries[0];
    const res = (
      await h
        .call("patch", `/api/credit-limits/${observed.id}`)
        .send({ effectiveDate: "2026-08-20", note: "bank letter dated Aug 20" })
        .expect(200)
    ).body;
    expect(res.entries[0]).toMatchObject({
      source: "plaid",
      effectiveDate: "2026-08-20",
      note: "bank letter dated Aug 20",
      limitMinor: 200000,
    });
    // Sending the same amount is not a change of amount.
    const same = (
      await h
        .call("patch", `/api/credit-limits/${observed.id}`)
        .send({ limitMinor: 200000 })
        .expect(200)
    ).body;
    expect(same.entries[0].source).toBe("plaid");
    // Blank note clears it.
    expect(
      (await h.call("patch", `/api/credit-limits/${observed.id}`).send({ note: "  " }).expect(200))
        .body.entries[0].note,
    ).toBeNull();
  });

  it("rejects bad edits", async () => {
    const entry = (await view()).entries[0];
    await h.call("patch", `/api/credit-limits/${entry.id}`).send({}).expect(400);
    await h.call("patch", `/api/credit-limits/${entry.id}`).send({ limitMinor: 0 }).expect(400);
    await h
      .call("patch", `/api/credit-limits/${entry.id}`)
      .send({ effectiveDate: "2026-02-30" })
      .expect(400);
    await h.call("patch", `/api/credit-limits/${entry.id}`).send({ accountId: 5 }).expect(400);
    await h.call("patch", "/api/credit-limits/99999").send({ note: "x" }).expect(404);
  });

  it("deletes an entry and recalculates the current limit and changes", async () => {
    await add({ limitMinor: 300000, effectiveDate: "2026-09-05" });
    const before = await view();
    expect(before.current.limitMinor).toBe(300000);
    const res = (await h.call("delete", `/api/credit-limits/${before.entries[0].id}`).expect(200))
      .body;
    expect(res.current.limitMinor).toBe(200000);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].changeMinor).toBeNull();
    await h.call("delete", "/api/credit-limits/99999").expect(404);
  });

  it("deleting every entry leaves no current limit", async () => {
    const only = (await view()).entries[0];
    const res = (await h.call("delete", `/api/credit-limits/${only.id}`).expect(200)).body;
    expect(res).toEqual({ current: null, entries: [] });
    const accountsRes = (await h.call("get", "/api/accounts").expect(200)).body;
    expect(accountsRes.find((a: { id: number }) => a.id === cardId()).creditLimitMinor).toBeNull();
  });

  it("a sync never edits or removes manual entries, and a deleted observation comes back only if the bank still reports it", async () => {
    await add({ limitMinor: 150000, effectiveDate: "2026-05-01", note: "mine" });
    const manual = h.db
      .select()
      .from(creditLimitHistory)
      .all()
      .find((e) => e.source === "manual")!;
    // The user deletes the observed entry; the bank still reports $2,000, so the next sync notes it again.
    const observed = (await view()).entries.find((e: { source: string }) => e.source === "plaid");
    await h.call("delete", `/api/credit-limits/${observed.id}`).expect(200);
    h.advanceDays(1);
    await h.sync.syncItem(itemId, "manual");
    const rows = h.db.select().from(creditLimitHistory).all();
    expect(rows.filter((e) => e.source === "plaid")).toHaveLength(1);
    expect(rows.find((e) => e.id === manual.id)).toMatchObject({
      limitMinor: 150000,
      note: "mine",
      effectiveDate: "2026-05-01",
      source: "manual",
    });

    // When the bank's number changes, a new observed entry is added and the manual one is still untouched.
    h.advanceDays(1);
    h.gateway.simulateCreditLimit(h.db.select().from(plaidItems).get()!.plaidItemId, 2500);
    await h.sync.syncItem(itemId, "manual");
    const after = h.db.select().from(creditLimitHistory).all();
    expect(
      after
        .filter((e) => e.source === "plaid")
        .map((e) => e.limitMinor)
        .sort(),
    ).toEqual([200000, 250000]);
    expect(after.find((e) => e.id === manual.id)).toMatchObject({
      limitMinor: 150000,
      note: "mine",
      effectiveDate: "2026-05-01",
      source: "manual",
    });
  });

  it("requires the API token", async () => {
    const { default: request } = await import("supertest");
    await request(h.app)
      .post(`/api/accounts/${cardId()}/credit-limits`)
      .set("Host", "127.0.0.1:47998")
      .send({})
      .expect(401);
    await request(h.app).delete("/api/credit-limits/1").set("Host", "127.0.0.1:47998").expect(401);
  });
});
