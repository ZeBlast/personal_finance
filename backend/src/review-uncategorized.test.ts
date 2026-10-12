import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("uncategorized transactions on the Review page", () => {
  it("lists every one without a category, newest first, but not transfers", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const account = (
      await t.call("post", "/api/accounts/manual").send({ name: "Cash", kind: "cash" }).expect(201)
    ).body.id as number;
    const food = (await t.call("post", "/api/categories").send({ name: "Food" }).expect(201)).body
      .id as number;
    const add = async (merchant: string, date: string, extra: Record<string, unknown> = {}) =>
      (
        await t
          .call("post", "/api/transactions")
          .send({
            accountId: account,
            date,
            merchant,
            amountMinor: 500,
            direction: "out",
            ...extra,
          })
          .expect(201)
      ).body.id as number;
    const old = await add("Old shop", "2020-01-05"); // long before the review window
    const recent = await add("New shop", "2026-09-01");
    await add("Bakery", "2026-09-02", { categoryId: food });
    await add("ATM", "2026-09-03", { isTransfer: true });

    const list = async () =>
      (await t.call("get", "/api/review/uncategorized").expect(200)).body as {
        items: Array<{ id: number }>;
        total: number;
      };
    expect(await list()).toMatchObject({ total: 2 });
    expect((await list()).items.map((i) => i.id)).toEqual([recent, old]);

    // Categorizing one takes it off the list.
    await t.call("patch", `/api/transactions/${old}`).send({ categoryId: food }).expect(200);
    expect((await list()).items.map((i) => i.id)).toEqual([recent]);
  });
});
