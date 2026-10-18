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
  await add("Corner Coffee", "2026-09-08");
  await add("Coffee Cart", "2026-09-15");
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
  return { treats, dining, existing, preview };
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
});
