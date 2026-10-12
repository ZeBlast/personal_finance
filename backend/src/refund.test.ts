import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A $50 purchase in September, and its $50 refund in October. */
async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Card", kind: "credit_card" })
      .expect(201)
  ).body.id as number;
  const shopping = (await t.call("post", "/api/categories").send({ name: "Shopping" }).expect(201))
    .body.id as number;
  const add = async (body: Record<string, unknown>) =>
    (
      await t
        .call("post", "/api/transactions")
        .send({ accountId: account, ...body })
        .expect(201)
    ).body.id as number;
  const charge = await add({
    date: "2026-09-10",
    merchant: "Outdoor Store",
    amountMinor: 5000,
    direction: "out",
    categoryId: shopping,
  });
  const refund = await add({
    date: "2026-10-02",
    merchant: "OUTDOOR STORE REFUND",
    amountMinor: 5000,
    direction: "in",
  });
  const months = async () =>
    (
      (
        await t
          .call("get", "/api/analytics/summary?from=2026-09-01&to=2026-10-31&groupBy=month")
          .expect(200)
      ).body.rows as Array<{ key: string; spendingMinor: number; incomeMinor: number }>
    ).map((r) => [r.key, r.spendingMinor, r.incomeMinor]);
  const byCategory = async () =>
    (
      (
        await t
          .call("get", "/api/analytics/summary?from=2026-09-01&to=2026-10-31&groupBy=category")
          .expect(200)
      ).body.rows as Array<{ label: string; spendingMinor: number }>
    ).map((r) => [r.label, r.spendingMinor]);
  const link = (id: number, originalId: number | null, status = 200) =>
    t.call("put", `/api/transactions/${id}/refund-of`).send({ originalId }).expect(status);
  return { t, add, charge, refund, months, byCategory, link };
}

describe("linking a refund with its charge", () => {
  it("takes the charge back out of spending, in its month and category", async () => {
    const { t, charge, refund, months, byCategory, link } = await setup();
    // Unlinked, the refund sits in October, uncategorized.
    expect(await months()).toEqual([
      ["2026-09", 5000, 0],
      ["2026-10", -5000, 0],
    ]);

    const suggestions = (
      await t.call("get", `/api/transactions/${refund}/refund-candidates`).expect(200)
    ).body as Array<{ transaction: { id: number }; namesAgree: boolean; exactAmount: boolean }>;
    expect(suggestions[0]).toMatchObject({
      transaction: { id: charge },
      namesAgree: true,
      exactAmount: true,
    });

    const linked = (await link(refund, charge)).body;
    expect(linked.refundOf).toMatchObject({
      id: charge,
      merchant: "Outdoor Store",
      amountMinor: 5000,
    });
    expect(
      (await t.call("get", `/api/transactions/${charge}`).expect(200)).body.refundedMinor,
    ).toBe(5000);
    // Now it nets out September's purchase, in Shopping, and October has nothing.
    expect(await months()).toEqual([["2026-09", 0, 0]]);
    expect(await byCategory()).toEqual([["Shopping", 0]]);

    await link(refund, null);
    expect(await months()).toEqual([
      ["2026-09", 5000, 0],
      ["2026-10", -5000, 0],
    ]);
  });

  it("allows partial refunds, never more than the charge, and only money back", async () => {
    const { add, charge, refund, link } = await setup();
    const more = await add({
      date: "2026-10-03",
      merchant: "Outdoor Store",
      amountMinor: 100,
      direction: "in",
    });
    await link(refund, charge);
    await link(more, charge, 409); // $50 + $1 back on a $50 charge
    await link(charge, refund, 400); // a charge is not a refund
    const early = await add({
      date: "2026-08-01",
      merchant: "Outdoor Store",
      amountMinor: 100,
      direction: "in",
    });
    await link(early, charge, 400); // before the charge
  });
});
