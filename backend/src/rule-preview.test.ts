import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const category = async (name: string) =>
    (await t.call("post", "/api/categories").send({ name }).expect(201)).body.id as number;
  const treats = await category("Treats");
  const dining = await category("Dining");
  const errands = await category("Errands");
  const existing = (
    await t
      .call("post", "/api/rules")
      .send({
        name: "Coffee",
        field: "merchant",
        operator: "contains",
        matchValue: "coffee",
        categoryId: treats,
      })
      .expect(201)
  ).body.id as number;
  const account = (
    await t.call("post", "/api/accounts/manual").send({ name: "Card", kind: "cash" }).expect(201)
  ).body.id as number;
  const add = (merchant: string, date: string, categoryId?: number) =>
    t
      .call("post", "/api/transactions")
      .send({ accountId: account, date, merchant, amountMinor: 500, direction: "out", categoryId })
      .expect(201);
  await add("Corner Coffee", "2026-09-01");
  const second = (await add("Corner Coffee", "2026-09-08")).body.id as number;
  const cart = (await add("Coffee Cart", "2026-09-15")).body.id as number;
  // Chosen by hand: rules never change it.
  await add("Coffee Cart", "2026-09-20", errands);
  await t.call("post", "/api/rules/apply").send({}).expect(200);
  const preview = async (body: Record<string, unknown>) =>
    (
      await t
        .call("post", "/api/rules/preview")
        .send({ field: "merchant", operator: "contains", matchValue: "coffee", ...body })
        .expect(200)
    ).body;
  const coffeeRule = {
    name: "Coffee spots",
    field: "merchant",
    operator: "contains",
    matchValue: "coffee",
  };
  const cartRule = { ...coffeeRule, name: "Carts", matchValue: "cart" };
  const categoryOf = async (id: number) =>
    (await t.call("get", `/api/transactions/${id}`).expect(200)).body.category?.name ?? null;
  return {
    t,
    account,
    treats,
    dining,
    errands,
    existing,
    preview,
    add,
    coffeeRule,
    cartRule,
    second,
    cart,
    categoryOf,
  };
}

describe("previewing a rule's real effect", () => {
  it("tells what saving a new rule would change, apart from what it merely matches", async () => {
    const { dining, preview } = await setup();
    const p = await preview({ categoryId: dining });
    expect(p.matchCount).toBe(4);
    // The three filed by the Coffee rule move to Dining; the one chosen by hand stays.
    expect(p.changeCount).toBe(3);
    expect(p.manualCount).toBe(1);
    expect(p.changes[0]).toMatchObject({ from: "Treats", to: "Dining", date: "2026-09-15" });
  });

  it("changes nothing when the rule already files them there", async () => {
    const { treats, preview } = await setup();
    const p = await preview({ categoryId: treats });
    expect(p).toMatchObject({ matchCount: 4, changeCount: 0, manualCount: 1, changes: [] });
  });

  it("previews an edited rule in its own place, including what it stops matching", async () => {
    const { dining, existing, preview } = await setup();
    // Same words, new category: the same three move.
    expect((await preview({ categoryId: dining, ruleId: existing })).changeCount).toBe(3);
    // Narrowed to "corner": the Coffee Cart purchase it used to file is left uncategorized.
    const narrowed = await preview({ matchValue: "corner", categoryId: dining, ruleId: existing });
    expect(narrowed.changeCount).toBe(3);
    expect(narrowed.changes).toContainEqual(
      expect.objectContaining({ merchant: "Coffee Cart", from: "Treats", to: null }),
    );
  });

  it("only counts matches without a category", async () => {
    const { preview } = await setup();
    expect(await preview({})).toEqual({
      matchCount: 4,
      sample: expect.any(Array),
    });
  });

  it("lists every change a page at a time, with what it does to each category's total", async () => {
    const { dining, treats, preview } = await setup();
    const p1 = await preview({ categoryId: dining, limit: 2 });
    expect(p1).toMatchObject({ changeCount: 3, changes: [expect.anything(), expect.anything()] });
    expect((await preview({ categoryId: dining, limit: 2, offset: 2 })).changes).toHaveLength(1);
    expect(p1.totals).toEqual([
      { categoryId: dining, name: "Dining", changeMinor: 1_500, count: 3 },
      { categoryId: treats, name: "Treats", changeMinor: -1_500, count: 3 },
    ]);
  });

  it("a rule for new transactions only leaves the past alone, even after Apply rules now", async () => {
    const { t, dining, preview, cartRule, cart, categoryOf } = await setup();
    await t
      .call("post", "/api/rules")
      .send({ ...cartRule, categoryId: dining, scope: "new" })
      .expect(201);
    expect(
      (await preview({ matchValue: "cart", categoryId: dining, scope: "new" })).changeCount,
    ).toBe(0);
    await t.call("post", "/api/rules/apply").send({}).expect(200);
    expect(await categoryOf(cart)).toBe("Treats");
    expect((await t.call("get", "/api/rules/batches")).body).toEqual([]);
    // Saved with no scope: today's behaviour, no start day.
    const plain = await t
      .call("post", "/api/rules")
      .send({ ...cartRule, name: "Plain", categoryId: dining })
      .expect(201);
    expect(plain.body.appliesFrom).toBeNull();
  });

  it("saving for past transactions too records a batch that undo puts back, keeping later edits", async () => {
    const { t, dining, errands, coffeeRule, second, cart, categoryOf } = await setup();
    await t
      .call("post", "/api/rules")
      .send({ ...coffeeRule, categoryId: dining, scope: "all" })
      .expect(201);
    const [batch] = (await t.call("get", "/api/rules/batches")).body;
    expect(batch).toMatchObject({ kind: "rule_saved", changeCount: 3, undoneAt: null });
    await t.call("patch", `/api/transactions/${second}`).send({ categoryId: errands }).expect(200);
    const undo = (await t.call("post", `/api/rules/batches/${batch.id}/undo`).expect(200)).body;
    expect(undo.restored).toBe(2);
    expect(undo.kept).toEqual([
      expect.objectContaining({ date: "2026-09-08", category: "Errands" }),
    ]);
    expect(await categoryOf(cart)).toBe("Treats");
    expect(await categoryOf(second)).toBe("Errands");
    await t.call("post", `/api/rules/batches/${batch.id}/undo`).expect(409);
    await t.call("post", "/api/rules/batches/9999/undo").expect(404);
    expect((await t.call("get", "/api/rules/batches")).body[0].undoneAt).not.toBeNull();
  });

  it("keeps a newer batch's category when an older batch is undone", async () => {
    const { t, dining, errands, coffeeRule, categoryOf, cart } = await setup();
    const rule = (
      await t
        .call("post", "/api/rules")
        .send({ ...coffeeRule, categoryId: dining, scope: "all" })
        .expect(201)
    ).body.id as number;
    await t
      .call("patch", `/api/rules/${rule}`)
      .send({ categoryId: errands, apply: true })
      .expect(200);
    const [newer, older] = (await t.call("get", "/api/rules/batches")).body;
    expect(newer.changeCount).toBe(3);
    const undoA = (await t.call("post", `/api/rules/batches/${older.id}/undo`).expect(200)).body;
    expect(undoA.restored).toBe(0);
    expect(undoA.kept).toHaveLength(3);
    expect(await categoryOf(cart)).toBe("Errands");
    // The newer batch still undoes cleanly back to what the older one left.
    const undoB = (await t.call("post", `/api/rules/batches/${newer.id}/undo`).expect(200)).body;
    expect(undoB.restored).toBe(3);
    expect(await categoryOf(cart)).toBe("Dining");
  });

  it("totals leave out income and transfers, as the reports do", async () => {
    const { t, dining, treats, account, preview } = await setup();
    const post = (body: Record<string, unknown>) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId: account, date: "2026-09-25", ...body })
        .expect(201);
    await post({ merchant: "Coffee Payroll", amountMinor: 2_000, direction: "in", sender: "Boss" });
    await post({ merchant: "Coffee Move", amountMinor: 700, direction: "out", isTransfer: true });
    const p = await preview({ categoryId: dining });
    expect(p.changeCount).toBe(5);
    expect(p.totals).toEqual([
      { categoryId: dining, name: "Dining", changeMinor: 1_500, count: 3 },
      { categoryId: treats, name: "Treats", changeMinor: -1_500, count: 3 },
    ]);
  });

  it("saving a rule changes only what its preview showed, not unrelated stale rows", async () => {
    const { t, dining, errands, coffeeRule, account, categoryOf } = await setup();
    const bakery = (
      await t
        .call("post", "/api/transactions")
        .send({
          accountId: account,
          date: "2026-09-10",
          merchant: "Bakery",
          amountMinor: 300,
          direction: "out",
        })
        .expect(201)
    ).body.id as number;
    // A rule that would file it, saved without applying: the row is stale.
    await t
      .call("post", "/api/rules")
      .send({ ...coffeeRule, name: "Bakery", matchValue: "bakery", categoryId: errands })
      .expect(201);
    expect(await categoryOf(bakery)).toBeNull();
    await t
      .call("post", "/api/rules")
      .send({ ...coffeeRule, categoryId: dining, scope: "all" })
      .expect(201);
    const [batch] = (await t.call("get", "/api/rules/batches")).body;
    expect(batch.changeCount).toBe(3);
    expect(await categoryOf(bakery)).toBeNull();
    // Apply rules now is the full re-check, and is recorded as its own batch.
    await t.call("post", "/api/rules/apply").send({}).expect(200);
    expect(await categoryOf(bakery)).toBe("Errands");
    const [applied] = (await t.call("get", "/api/rules/batches")).body;
    expect(applied).toMatchObject({ kind: "rules_applied", changeCount: 1 });
  });

  it("clears the start day, and a transaction on that exact day is covered", async () => {
    const { t, dining, cartRule, add, preview } = await setup();
    const rule = (
      await t
        .call("post", "/api/rules")
        .send({ ...cartRule, categoryId: dining, scope: "new" })
        .expect(201)
    ).body;
    const today = new Date().toISOString().slice(0, 10);
    expect(rule.appliesFrom).toBe(today);
    await add("Cart Today", today);
    const p = await preview({ matchValue: "cart", categoryId: dining, scope: "new" });
    expect(p.matchCount).toBe(1);
    // Disabled, its start day still counts in the preview.
    await t.call("patch", `/api/rules/${rule.id}`).send({ enabled: false }).expect(200);
    expect(
      (await preview({ matchValue: "cart", categoryId: dining, ruleId: rule.id })).matchCount,
    ).toBe(1);
    const cleared = await t
      .call("patch", `/api/rules/${rule.id}`)
      .send({ appliesFrom: null })
      .expect(200);
    expect(cleared.body.appliesFrom).toBeNull();
  });
});
