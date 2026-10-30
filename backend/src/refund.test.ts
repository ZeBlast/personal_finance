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
    ).body.suggestions as Array<{
      transaction: { id: number };
      namesAgree: boolean;
      exactAmount: boolean;
    }>;
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

describe("finding what a refund gives back", () => {
  type Found = {
    suggestions: Array<{
      transaction: { id: number };
      exactAmount: boolean;
      daysBefore: number;
      leftMinor: number | null;
    }>;
    more: boolean;
    range: "recent" | "all";
  };

  it("searches by merchant, account, category or amount, through all history", async () => {
    const { t, add, charge, refund, link } = await setup();
    await link(refund, null); // so the September charge is free again
    const old = await add({
      date: "2025-11-20",
      merchant: "Camping World",
      amountMinor: 12999,
      direction: "out",
    });
    const coffee = await add({
      date: "2026-09-30",
      merchant: "Coffee",
      amountMinor: 6000,
      direction: "out",
    });
    const find = async (query: string) =>
      (await t.call("get", `/api/transactions/${refund}/refund-candidates${query}`).expect(200))
        .body as Found;
    const ids = (f: Found) => f.suggestions.map((s) => s.transaction.id);

    // Within 6 months: the charge first (same merchant), then the coffee; not last November's.
    const recent = await find("");
    expect(recent.range).toBe("recent");
    expect(ids(recent)).toEqual([charge, coffee]);
    expect((await find("?all=true")).suggestions.map((s) => s.transaction.id)).toContain(old);
    // A search looks through everything.
    const camping = await find("?q=camping");
    expect([ids(camping), camping.range]).toEqual([[old], "all"]);
    expect(ids(await find("?q=129.99"))).toEqual([old]);
    expect(ids(await find("?q=%24129"))).toEqual([old]);
    expect(ids(await find("?q=129.00"))).toEqual([]);
    expect(ids(await find("?q=shopping"))).toEqual([charge]);
    expect(ids(await find("?q=card%2060"))).toEqual([coffee]);
    expect(ids(await find("?q=nothing"))).toEqual([]);
    // A few at a time.
    const one = await find("?all=true&limit=1");
    expect([ids(one), one.more]).toEqual([[charge], true]);
  });

  it("leaves out charges with too little left to give back, and says what is left", async () => {
    const { t, add, charge, refund, link } = await setup();
    await link(refund, null);
    const half = await add({
      date: "2026-10-01",
      merchant: "Outdoor Store",
      amountMinor: 2000,
      direction: "in",
    });
    await link(half, charge); // $20 of the $50 back
    const suggestions = (
      await t.call("get", `/api/transactions/${refund}/refund-candidates`).expect(200)
    ).body.suggestions as Found["suggestions"];
    // $50 back no longer fits a charge with $30 left.
    expect(suggestions.map((s) => s.transaction.id)).not.toContain(charge);

    const small = await add({
      date: "2026-10-04",
      merchant: "Outdoor Store",
      amountMinor: 3000,
      direction: "in",
    });
    const forSmall = (
      await t.call("get", `/api/transactions/${small}/refund-candidates`).expect(200)
    ).body.suggestions as Found["suggestions"];
    expect(forSmall[0]).toMatchObject({
      transaction: { id: charge },
      leftMinor: 3000,
      exactAmount: true, // exactly what is left
      daysBefore: 24,
    });
  });

  it("from a charge: finds money back that could be its refund, and lists the linked ones", async () => {
    const { t, add, charge, refund, link } = await setup();
    await link(refund, null);
    const tooBig = await add({
      date: "2026-10-03",
      merchant: "Outdoor Store",
      amountMinor: 9000,
      direction: "in",
    });
    const before = await add({
      date: "2026-08-01",
      merchant: "Outdoor Store",
      amountMinor: 1000,
      direction: "in",
    });
    const found = (await t.call("get", `/api/transactions/${charge}/refund-candidates`).expect(200))
      .body as Found;
    const ids = found.suggestions.map((s) => s.transaction.id);
    expect(ids[0]).toBe(refund);
    expect(ids).not.toContain(tooBig); // more than was charged
    expect(ids).not.toContain(before); // before the charge
    expect(found.suggestions[0]).toMatchObject({ exactAmount: true, leftMinor: null });

    await link(refund, charge);
    const linked = (await t.call("get", `/api/transactions/${charge}/refunds`).expect(200))
      .body as Array<{ id: number }>;
    expect(linked.map((r) => r.id)).toEqual([refund]);
    // Fully refunded: nothing more to find.
    expect(
      (await t.call("get", `/api/transactions/${charge}/refund-candidates`).expect(200)).body
        .suggestions,
    ).toEqual([]);
  });

  it("ranks money back on the same account first, and pay or interest last", async () => {
    const { t, add, charge, refund, link } = await setup();
    await link(refund, null);
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const pay = (await t.call("post", "/api/categories").send({ name: "Pay" }).expect(201)).body
      .id as number;
    await t.call("patch", `/api/categories/${pay}`).send({ incomeTreatment: "income" }).expect(200);
    const inChecking = async (body: Record<string, unknown>) =>
      (
        await t
          .call("post", "/api/transactions")
          .send({ accountId: checking, direction: "in", ...body })
          .expect(201)
      ).body.id as number;
    // Closest in date, but pay on another account; then money from a friend on another account;
    // then a credit on the card that paid.
    const interest = await inChecking({
      date: "2026-09-11",
      merchant: "Interest",
      amountMinor: 100,
      categoryId: pay,
    });
    const friend = await inChecking({ date: "2026-09-12", merchant: "Sam", amountMinor: 2000 });
    const cardCredit = await add({
      date: "2026-09-20",
      merchant: "Statement adjustment",
      amountMinor: 1000,
      direction: "in",
    });
    const found = (await t.call("get", `/api/transactions/${charge}/refund-candidates`).expect(200))
      .body as Found;
    expect(found.suggestions.map((s) => s.transaction.id)).toEqual([
      refund,
      cardCredit,
      friend,
      interest,
    ]);
  });

  it("reads amounts the way people type them", async () => {
    const { matchesRefundSearch } = await import("./services/refund.service.js");
    const row = { text: "AMZN Mktp US", account: "Visa", category: "Shopping", amount: 125050 };
    expect(matchesRefundSearch("1,250.50", row)).toBe(true);
    expect(matchesRefundSearch("$1250", row)).toBe(true);
    expect(matchesRefundSearch("1250.5", row)).toBe(true);
    expect(matchesRefundSearch("1251", row)).toBe(false);
    expect(matchesRefundSearch("amzn visa", row)).toBe(true);
    expect(matchesRefundSearch("amzn target", row)).toBe(false);
  });
});
