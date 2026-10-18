import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { allocateProportionally } from "./services/refund-allocation.service.js";
import { makeTestApp } from "./test-helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A $170 purchase split $120 Entertainment / $50 Food, and an $80 reimbursement for it. */
async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Card", kind: "credit_card" })
      .expect(201)
  ).body.id as number;
  const category = async (name: string) =>
    (await t.call("post", "/api/categories").send({ name }).expect(201)).body.id as number;
  const fun = await category("Fun");
  const food = await category("Meals");
  const other = await category("Misc");
  const add = async (body: Record<string, unknown>) =>
    (
      await t
        .call("post", "/api/transactions")
        .send({ accountId: account, ...body })
        .expect(201)
    ).body.id as number;
  const charge = await add({
    date: "2026-10-11",
    merchant: "Donkeys & Scooters",
    amountMinor: 17000,
    direction: "out",
    categoryId: fun,
  });
  await t
    .call("put", `/api/transactions/${charge}/splits`)
    .send({
      parts: [
        { categoryId: fun, amountMinor: 12000 },
        { categoryId: food, amountMinor: 5000 },
      ],
    })
    .expect(200);
  const refund = await add({
    date: "2026-10-12",
    merchant: "Kevin",
    amountMinor: 8000,
    direction: "in",
  });
  const link = (id: number, originalId: number | null, status = 200) =>
    t.call("put", `/api/transactions/${id}/refund-of`).send({ originalId }).expect(status);
  const split = (id: number, parts: unknown[], status = 200) =>
    t.call("put", `/api/transactions/${id}/splits`).send({ parts }).expect(status);
  const allocation = async (id: number) =>
    (await t.call("get", `/api/transactions/${id}/refund-allocation`).expect(200)).body;
  const spending = async () =>
    Object.fromEntries(
      (
        (
          await t
            .call("get", "/api/analytics/summary?from=2026-10-01&to=2026-10-31&groupBy=category")
            .expect(200)
        ).body.rows as Array<{ label: string; spendingMinor: number }>
      ).map((r) => [r.label, r.spendingMinor]),
    );
  return { t, add, charge, refund, fun, food, other, link, split, allocation, spending };
}

describe("dividing a refund of a split purchase across its categories", () => {
  it("divides in proportion by default, then by the amounts the user sets", async () => {
    const { charge, refund, fun, food, link, split, allocation, spending } = await setup();
    await link(refund, charge);
    // $80 of $170, in proportion: $56.47 back to Fun, $23.53 to Meals.
    expect(await allocation(refund)).toMatchObject({
      originalId: charge,
      refundMinor: 8000,
      lines: [
        { categoryId: fun, spentMinor: 12000, leftMinor: 12000, thisMinor: 5647 },
        { categoryId: food, spentMinor: 5000, leftMinor: 5000, thisMinor: 2353 },
      ],
    });
    expect(await spending()).toMatchObject({ Fun: 12000 - 5647, Meals: 5000 - 2353 });

    await split(refund, [
      { categoryId: fun, amountMinor: -5000 },
      { categoryId: food, amountMinor: -3000 },
    ]);
    expect(await spending()).toMatchObject({ Fun: 7000, Meals: 2000 });

    // All of it back to one category is fine.
    await split(refund, [{ categoryId: food, amountMinor: -5000 }], 400); // does not add up
    await split(refund, [{ categoryId: fun, amountMinor: -8000 }]);
    expect(await spending()).toMatchObject({ Fun: 4000, Meals: 5000 });
  });

  it("never gives a category back more than is left, nor a category the purchase did not have", async () => {
    const { add, charge, refund, fun, food, other, link, split, allocation } = await setup();
    await link(refund, charge);
    const tooMuch = await split(
      refund,
      [
        { categoryId: fun, amountMinor: -2000 },
        { categoryId: food, amountMinor: -6000 },
      ],
      409,
    );
    expect(tooMuch.body.error).toBe("refund_exceeds_category");
    await split(
      refund,
      [
        { categoryId: fun, amountMinor: -4000 },
        { categoryId: other, amountMinor: -4000 },
      ],
      400,
    );
    await split(
      refund,
      [
        { categoryId: fun, amountMinor: -9000 },
        { categoryId: food, amountMinor: 1000 },
      ],
      400,
    );

    // A second refund sees only what the first left: $120 − $80 in Fun, all $50 in Meals.
    await split(refund, [{ categoryId: fun, amountMinor: -8000 }]);
    const second = await add({
      date: "2026-10-13",
      merchant: "Sam",
      amountMinor: 6000,
      direction: "in",
    });
    await link(second, charge);
    expect((await allocation(second)).lines).toMatchObject([
      { categoryId: fun, refundedElsewhereMinor: 8000, leftMinor: 4000 },
      { categoryId: food, refundedElsewhereMinor: 0, leftMinor: 5000 },
    ]);
    await split(second, [{ categoryId: fun, amountMinor: -6000 }], 409);
  });

  it("drops the division when the purchase is no longer split", async () => {
    const { t, charge, refund, link, split, allocation } = await setup();
    await link(refund, charge);
    await split(charge, []);
    expect(await allocation(refund)).toBeNull();
    expect((await t.call("get", `/api/transactions/${refund}`).expect(200)).body.splits).toEqual(
      [],
    );
  });

  it("clears the division on unlink", async () => {
    const { t, charge, refund, link } = await setup();
    await link(refund, charge);
    expect(
      (await t.call("get", `/api/transactions/${refund}`).expect(200)).body.splits,
    ).toHaveLength(2);
    await link(refund, null);
    expect((await t.call("get", `/api/transactions/${refund}`).expect(200)).body.splits).toEqual(
      [],
    );
  });
});

describe("splitting a reimbursed purchase by what was kept", () => {
  it("splits only what is left after the reimbursement; the reimbursement stays unsplit and counts nowhere else", async () => {
    const { t, add, fun, food, link, split, spending } = await setup();
    const paybacks = (
      await t
        .call("post", "/api/categories")
        .send({ name: "Paybacks", incomeTreatment: "refund" })
        .expect(201)
    ).body.id as number;
    const dinner = await add({
      date: "2026-10-20",
      merchant: "Steakhouse",
      amountMinor: 17000,
      direction: "out",
      categoryId: fun,
    });
    const back = await add({
      date: "2026-10-21",
      merchant: "Alex",
      amountMinor: 8000,
      direction: "in",
      categoryId: paybacks,
    });
    await link(back, dinner);

    // $90 kept: $60 Fun, $30 Meals. The full $170 is no longer asked for.
    const saved = (
      await split(dinner, [
        { categoryId: fun, amountMinor: 6000 },
        { categoryId: food, amountMinor: 3000 },
      ])
    ).body;
    // Only the purchase's own categories: no part for what was reimbursed.
    expect(saved.splits.map((s: { amountMinor: number }) => s.amountMinor)).toEqual([6000, 3000]);
    expect(saved.splitValid).toBe(true);
    // The reimbursement keeps its own category and is not split ("split 1 way").
    const reimbursement = (await t.call("get", `/api/transactions/${back}`).expect(200)).body;
    expect(reimbursement.splits).toEqual([]);
    expect(reimbursement.category.name).toBe("Paybacks");

    const before = await spending();
    // The first purchase in setup ($120 Fun / $50 Meals, its refund not linked) is there too.
    expect(before["Fun"]).toBe(12000 + 6000);
    expect(before["Meals"]).toBe(5000 + 3000);
    expect(before["Paybacks"] ?? 0).toBe(0);

    // The transactions chart has no reimbursement line at all, either way.
    const chart = (
      await t
        .call("get", "/api/analytics/category-trends?from=2026-10-01&to=2026-10-31&flow=all")
        .expect(200)
    ).body as { series: Array<{ label: string; values: number[] }> };
    expect(chart.series.some((s) => s.label.startsWith("Paybacks"))).toBe(false);
    expect(chart.series.find((s) => s.label === "Fun · out")?.values[0]).toBe(12000 + 6000);

    // The network graph shows the kept parts and leaves the reimbursement out.
    const graph = (
      await t.call("get", "/api/graph/transactions?from=2026-10-01&to=2026-10-31").expect(200)
    ).body as { transactions: Array<{ id: number; splits: Array<{ amountMinor: number }> }> };
    expect(graph.transactions.some((x) => x.id === back)).toBe(false);
    expect(
      graph.transactions.find((x) => x.id === dinner)!.splits.map((s) => s.amountMinor),
    ).toEqual([6000, 3000]);

    // A total that is neither the purchase nor what was kept is refused.
    await split(dinner, [{ categoryId: fun, amountMinor: 5000 }], 400);

    // Unlinking the reimbursement leaves the purchase whole again.
    await link(back, null);
    const whole = (await t.call("get", `/api/transactions/${dinner}`).expect(200)).body;
    expect(whole.splits).toEqual([]);
  });
});

describe("purchases split by what was kept, saved the old way", () => {
  it("lose the reimbursed part, and their reimbursements their one-part split", async () => {
    const { t, add, fun, food, link, spending } = await setup();
    const dinner = await add({
      date: "2026-10-20",
      merchant: "Steakhouse",
      amountMinor: 17000,
      direction: "out",
      categoryId: fun,
    });
    const back = await add({
      date: "2026-10-21",
      merchant: "Alex",
      amountMinor: 8000,
      direction: "in",
    });
    await link(back, dinner);
    // The old layout: kept parts plus a "Reimbursed" part, and the reimbursement split one way.
    const insert = t.sqlite.prepare(
      "insert into transaction_splits (transaction_id, category_id, amount_minor, note, position, created_at) values (?, ?, ?, ?, ?, '2026-10-21')",
    );
    insert.run(dinner, fun, 6000, null, 0);
    insert.run(dinner, food, 3000, null, 1);
    insert.run(dinner, null, 8000, "Reimbursed", 2);
    insert.run(back, null, -8000, null, 0);

    // The cleanup statements of migration 0040, before it recreates the view.
    const migration = fs.readFileSync(
      path.join(here, "../../drizzle/migrations/0040_kept_splits.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint").slice(0, 2)) {
      t.sqlite.exec(statement);
    }

    const amounts = (id: number) =>
      (
        t.sqlite
          .prepare(
            "select amount_minor from transaction_splits where transaction_id = ? order by position",
          )
          .all(id) as Array<{ amount_minor: number }>
      ).map((r) => r.amount_minor);
    expect(amounts(dinner)).toEqual([6000, 3000]);
    expect(amounts(back)).toEqual([]);
    const after = await spending();
    expect(after["Fun"]).toBe(12000 + 6000);
    expect(after["Meals"]).toBe(5000 + 3000);
  });
});

describe("dividing cents in proportion", () => {
  it("adds up exactly", () => {
    expect(allocateProportionally(8000, [12000, 5000])).toEqual([5647, 2353]);
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportionally(10, [0, 0])).toEqual([5, 5]);
  });
});
