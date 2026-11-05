import { eq } from "drizzle-orm";
import { transactions } from "../../drizzle/schema.js";
import { afterEach, describe, expect, it } from "vitest";
import { summarize } from "./services/analytics.service.js";
import { cashForecast, instalmentEvents } from "./services/forecast.service.js";
import { detectInternalTransfers } from "./services/transfer.service.js";
import { refundCandidates, refundReview } from "./services/refund.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A $200 card purchase on Sep 1, and four $50 "PAYPAL PAY IN 4" payments from checking. */
async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = async (name: string, kind: string) =>
    (await t.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
  const card = await account("Card", "credit_card");
  const checking = await account("Checking", "checking");
  const add = async (
    accountId: number,
    date: string,
    merchant: string,
    amountMinor: number,
    direction: "in" | "out" = "out",
  ) =>
    (
      await t
        .call("post", "/api/transactions")
        .send({ accountId, date, merchant, amountMinor, direction })
        .expect(201)
    ).body.id as number;
  const purchase = await add(card, "2026-09-01", "Gadget Store", 20_000);
  const repayments: number[] = [];
  for (const day of ["2026-09-01", "2026-09-15", "2026-09-29", "2026-10-13"]) {
    repayments.push(await add(checking, day, "PAYPAL PAY IN 4", 5000));
  }
  const spent = () =>
    summarize(t.db, {
      from: "2026-09-01",
      to: "2026-10-31",
      groupBy: "none",
      includeTransfers: false,
      includePending: true,
      fill: false,
      environment: "fake",
    }).totals.spendingMinor;
  const get = async (id: number) =>
    (await t.call("get", `/api/transactions/${id}`).expect(200)).body;
  const link = (id: number, purchaseId: number | null, status = 200) =>
    t.call("put", `/api/transactions/${id}/instalment-of`).send({ purchaseId }).expect(status);
  return { t, card, checking, add, purchase, repayments, spent, get, link };
}

describe("a purchase paid in instalments", () => {
  it("counts a purchase paid in four once, at the purchase", async () => {
    const { t, purchase, repayments, spent, get, link } = await setup();
    expect(spent()).toBe(40_000);
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    const found = await t.call("get", `/api/transactions/${purchase}/instalment-candidates`);
    expect(found.body).toHaveLength(4);
    for (const r of repayments) await link(r, purchase);
    expect(spent()).toBe(20_000);
    expect((await get(purchase)).instalmentPlan).toEqual({
      instalments: 4,
      paidMinor: 20_000,
      repaymentCount: 4,
    });
    expect(await get(repayments[0]!)).toMatchObject({
      isTransfer: true,
      transferSource: "instalment",
      instalmentOfId: purchase,
    });
    // Detection running again leaves the links alone.
    detectInternalTransfers(t.db);
    expect(spent()).toBe(20_000);
  });

  it("refuses repayments beyond the purchase, and unmarking counts them again", async () => {
    const { t, checking, add, purchase, repayments, spent, link } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    for (const r of repayments) await link(r, purchase);
    const fifth = await add(checking, "2026-10-27", "PAYPAL PAY IN 4", 5000);
    const refused = await link(fifth, purchase, 409);
    expect(refused.body.error).toBe("repayments_exceed_purchase");
    await t.call("delete", `/api/transactions/${purchase}/instalments`).expect(204);
    expect(spent()).toBe(45_000);
  });

  it("will not link a refund or a transfer as a repayment", async () => {
    const { t, card, checking, add, purchase, link } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    const refund = await add(card, "2026-09-20", "Gadget Store", 5000, "in");
    await link(refund, purchase, 400);
    // Money out of checking and into the card, matched as a transfer between the two.
    const out = await add(checking, "2026-10-01", "Online transfer to card", 5000);
    await add(card, "2026-10-01", "ONLINE PAYMENT - THANK YOU", 5000, "in");
    await link(out, purchase, 400);
    // An unmarked purchase takes no repayments.
    const other = await add(card, "2026-09-02", "Elsewhere", 1000);
    await link(out, other, 409);
  });

  it("puts an unlinked repayment back exactly as it was", async () => {
    const { t, add, checking, purchase, get, link, spent } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    const cat = (await t.call("post", "/api/categories").send({ name: "Gadgets" }).expect(201)).body
      .id as number;
    // The user said this is not a transfer, and gave it a category.
    const r = await add(checking, "2026-09-10", "PAYPAL PAY IN 4", 5000);
    await t.call("patch", `/api/transactions/${r}`).send({ categoryId: cat, isTransfer: false });
    const before = await get(r);
    expect(before).toMatchObject({ isTransfer: false, transferSource: "manual" });
    await link(r, purchase);
    await link(r, null);
    const after = await get(r);
    expect(after).toMatchObject({
      isTransfer: before.isTransfer,
      transferSource: before.transferSource,
      instalmentOfId: null,
    });
    expect(after.category).toEqual(before.category);
    expect(spent()).toBe(45_000);
    // Unmarking the purchase restores a linked repayment the same way.
    await link(r, purchase);
    await t.call("delete", `/api/transactions/${purchase}/instalments`).expect(204);
    expect(await get(r)).toMatchObject({ isTransfer: false, transferSource: "manual" });
  });

  it("is never suggested as a refund, nor linked to its purchase as one", async () => {
    const { t, checking, add, purchase, repayments, link, get } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    await link(repayments[0]!, purchase);
    // A credit that looks like it could give a repayment back.
    const credit = await add(checking, "2026-09-20", "PAYPAL PAY IN 4", 5000, "in");
    detectInternalTransfers(t.db);
    expect((await get(credit)).refundOf?.id).not.toBe(repayments[0]);
    const ids = (id: number) =>
      refundCandidates(t.db, id, { all: true }).suggestions.map((s) => s.transaction.id);
    expect(ids(credit)).not.toContain(repayments[0]);
    const review = refundReview(t.db, "2026-10-20");
    expect(review.map((i) => i.suggestion.transaction.id)).not.toContain(repayments[0]);
    expect(review.map((i) => i.credit.id)).not.toContain(repayments[0]);
    // By hand, a linked repayment is no charge and no refund.
    await t
      .call("put", `/api/transactions/${credit}/refund-of`)
      .send({ originalId: repayments[0] })
      .expect(400);
    await t
      .call("put", `/api/transactions/${repayments[0]}/refund-of`)
      .send({ originalId: purchase })
      .expect(400);
    // Nor is it a transfer to flag or pair.
    await t
      .call("patch", `/api/transactions/${repayments[0]}`)
      .send({ isTransfer: false })
      .expect(409);
  });

  it("keeps a marked purchase from becoming a transfer", async () => {
    const { t, purchase, spent, get } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    const before = spent();
    await t.call("patch", `/api/transactions/${purchase}`).send({ isTransfer: true }).expect(409);
    detectInternalTransfers(t.db);
    expect((await get(purchase)).isTransfer).toBe(false);
    expect(spent()).toBe(before);
  });

  it("refuses edits that would break the cap or the direction", async () => {
    const { t, purchase, repayments, link } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    for (const r of repayments) await link(r, purchase);
    const edit = (id: number, body: object, status: number) =>
      t.call("patch", `/api/transactions/${id}`).send(body).expect(status);
    // The four payments already come to the whole purchase.
    await edit(repayments[0]!, { amountMinor: 5100 }, 409);
    await edit(repayments[0]!, { direction: "in" }, 409);
    await edit(purchase, { amountMinor: 19_000 }, 409);
    await edit(purchase, { direction: "in" }, 409);
    await edit(repayments[0]!, { amountMinor: 4900 }, 200);
    await edit(purchase, { amountMinor: 25_000 }, 200);
  });

  it("unlinks the newest repayments when a sync shrinks the purchase", async () => {
    const { t, purchase, repayments, link, get, spent } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    for (const r of repayments) await link(r, purchase);
    t.db
      .update(transactions)
      .set({ amountMinor: 12_000 })
      .where(eq(transactions.id, purchase))
      .run();
    detectInternalTransfers(t.db);
    expect((await get(repayments[0]!)).instalmentOfId).toBe(purchase);
    expect((await get(repayments[1]!)).instalmentOfId).toBe(purchase);
    expect(await get(repayments[3]!)).toMatchObject({ instalmentOfId: null, isTransfer: false });
    expect((await get(purchase)).instalmentPlan?.repaymentCount).toBe(2);
    expect(spent()).toBe(12_000 + 10_000);
  });

  it("keeps the rest of a plan in the cash forecast, and counts spending once", async () => {
    const { t, purchase, repayments, link, spent } = await setup();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
    await link(repayments[0]!, purchase);
    await link(repayments[1]!, purchase);
    const f = cashForecast(t.db, { today: "2026-09-20", days: 60 });
    const found = f.days.flatMap((d) => d.events.map((e) => ({ date: d.date, ...e })));
    expect(
      found.filter((e) => e.source === "instalment").map((e) => [e.date, e.label, e.amountMinor]),
    ).toEqual([
      ["2026-09-29", "Instalment for Gadget Store", -5000],
      ["2026-10-13", "Instalment for Gadget Store", -5000],
    ]);
    // The repayments' own series is not projected on top.
    expect(found.filter((e) => e.source === "recurring")).toEqual([]);
    // $200 for the purchase, and the two repayments not yet linked.
    expect(spent()).toBe(20_000 + 10_000);
  });

  it("refuses to mark a pending purchase", async () => {
    const { t, purchase } = await setup();
    t.db.update(transactions).set({ pending: true }).where(eq(transactions.id, purchase)).run();
    const res = await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(409);
    expect(res.body.error).toBe("pending_purchase");
    t.db.update(transactions).set({ pending: false }).where(eq(transactions.id, purchase)).run();
    await t
      .call("put", `/api/transactions/${purchase}/instalments`)
      .send({ instalments: 4 })
      .expect(200);
  });

  it("splits what is left over the payments left, remainder last, and skips a finished plan", () => {
    const plan = {
      merchant: "Shop",
      instalments: 3,
      purchaseMinor: 10_000,
      repayments: [{ date: "2026-09-01", amountMinor: 3333, accountId: 1 }],
    };
    const out = instalmentEvents([plan], "2026-12-31");
    expect(out.map((o) => [o.date, o.event.amountMinor])).toEqual([
      ["2026-09-15", -3333],
      ["2026-09-29", -3334],
    ]);
    expect(instalmentEvents([{ ...plan, instalments: 1 }], "2026-12-31")).toEqual([]);
    expect(instalmentEvents([{ ...plan, repayments: [] }], "2026-12-31")).toEqual([]);
  });
});
