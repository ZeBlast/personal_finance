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
    const { t, add, charge, refund, months, byCategory, link } = await setup();
    // The same merchant and amount a few weeks later: the app links it by itself.
    const found = (await t.call("get", `/api/transactions/${refund}`).expect(200)).body;
    expect(found.refundOf).toMatchObject({ id: charge, source: "auto" });
    expect(await months()).toEqual([["2026-09", 0, 0]]);

    // Saying it is not a refund sticks: the refund sits in October again, uncategorized, and
    // detection running again leaves it alone.
    await link(refund, null);
    await add({ date: "2026-10-05", merchant: "Coffee", amountMinor: 300, direction: "out" });
    expect(
      (await t.call("get", `/api/transactions/${refund}`).expect(200)).body.refundOf,
    ).toBeNull();
    expect(await months()).toEqual([
      ["2026-09", 5000, 0],
      ["2026-10", -4700, 0],
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
      source: "manual",
    });
    expect(
      (await t.call("get", `/api/transactions/${charge}`).expect(200)).body.refundedMinor,
    ).toBe(5000);
    // It nets out September's purchase, in Shopping; October keeps only the coffee.
    expect(await months()).toEqual([
      ["2026-09", 0, 0],
      ["2026-10", 300, 0],
    ]);
    expect(await byCategory()).toEqual(expect.arrayContaining([["Shopping", 0]]));
  });

  it("detects refunds only when one charge clearly fits, never between people", async () => {
    const { matchRefunds } = await import("./services/refund.service.js");
    const r = (id: number, date: string, amount: number, text: string) => ({
      id,
      date,
      amount,
      currency: "USD",
      text,
    });
    // Two equal charges at the same merchant: which one is unclear, so neither.
    expect(
      matchRefunds(
        [r(1, "2026-03-10", 500, "WONDER REFUND")],
        [r(2, "2026-03-01", 500, "WONDER"), r(3, "2026-03-05", 500, "Wonder")],
      ),
    ).toEqual([]);
    // Zelle from one person is not a refund of a Zelle to another.
    expect(
      matchRefunds(
        [r(1, "2025-10-20", 3000, "Zelle payment from MINLIN CHEN")],
        [r(2, "2025-10-14", 3000, "Zelle payment to DI NGUYEN")],
      ),
    ).toEqual([]);
    // Too long after, a different amount, or another merchant: no.
    expect(
      matchRefunds([r(1, "2026-09-01", 500, "Temu refund")], [r(2, "2026-01-01", 500, "Temu")]),
    ).toEqual([]);
    expect(
      matchRefunds(
        [r(1, "2026-02-11", 888, "Refund from Temu.com")],
        [r(2, "2026-02-11", 888, "Payment to Temu.com")],
      ),
    ).toEqual([[1, 2]]);
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
