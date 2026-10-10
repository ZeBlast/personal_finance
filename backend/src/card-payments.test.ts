import { afterEach, describe, expect, it } from "vitest";
import { isCardPayment } from "./services/transfer.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("what counts as a card payment", () => {
  it("is a payment, not a promotion, cashback redemption, or refund", () => {
    const yes = (name: string, category: string | null = null) =>
      expect(isCardPayment({ name, category }), name).toBe(true);
    const no = (name: string, category: string | null = null) =>
      expect(isCardPayment({ name, category }), name).toBe(false);
    yes("PAYMENT FROM CHK 1136 CONF#x1fec");
    yes("ONLINE PAYMENT - THANK YOU");
    yes("AUTOPAY", null);
    yes("Something", "LOAN_PAYMENTS");
    no("$10 PAZE CREDIT THANK YOU 00");
    no("CASH REWARDS STATEMENT CREDIT");
    no("BANKAMERIDEALS CASHBACK", "INCOME");
    no("REFUND AMAZON");
    no("Return: Mens Wearhouse");
    no("PURCHASE PROTECTION BENEFIT PAYMENT", "INCOME");
    no("Some payout", "INCOME");
  });
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = async (name: string, kind: string) =>
    (await t.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
  const card = await account("Rewards Card", "credit_card");
  const checking = await account("Checking", "checking");
  const add = async (
    accountId: number,
    date: string,
    merchant: string,
    amountMinor: number,
    direction: "in" | "out",
  ) =>
    (
      await t
        .call("post", "/api/transactions")
        .send({ accountId, date, merchant, amountMinor, direction })
        .expect(201)
    ).body.id as number;
  const get = async (id: number) =>
    (await t.call("get", `/api/transactions/${id}`).expect(200)).body;
  return { t, card, checking, add, get };
}

describe("card payments and the money that paid them", () => {
  it("are linked even days apart, and each side says which account is on the other", async () => {
    const { card, checking, add, get } = await setup();
    // The card shows the payment on Oct 2; the checking account shows the money leaving on Oct 8.
    const payment = await add(card, "2026-10-02", "PAYMENT - THANK YOU", 25000, "in");
    const paid = await add(checking, "2026-10-08", "CARD BILL", 25000, "out");
    const p = await get(payment);
    expect(p).toMatchObject({
      isTransfer: true,
      accountType: "credit",
      transferWith: { id: paid, accountName: "Checking", accountType: "depository" },
    });
    expect((await get(paid)).transferWith).toMatchObject({
      id: payment,
      accountName: "Rewards Card",
    });
  });

  it("does not link promotions, cashback redemptions, or refunds", async () => {
    const { card, checking, add, get } = await setup();
    const promo = await add(card, "2026-10-02", "$10 PAZE CREDIT THANK YOU", 1000, "in");
    const cashback = await add(card, "2026-10-03", "CASH REWARDS STATEMENT CREDIT", 1000, "in");
    await add(checking, "2026-10-03", "ONLINE PMT", 1000, "out");
    expect((await get(promo)).transferWith).toBeNull();
    expect((await get(cashback)).transferWith).toBeNull();
  });

  it("counts the debt paid on the day the paying account's money left", async () => {
    const { t, card, checking, add } = await setup();
    await add(card, "2026-10-02", "PAYMENT - THANK YOU", 25000, "in");
    await add(checking, "2026-10-08", "CARD BILL", 25000, "out");
    const days = (await t.call("get", "/api/analytics/calendar?month=2026-10").expect(200)).body
      .days as Array<{ date: string; debtPaidMinor: number }>;
    const paidOn = (date: string) => days.find((d) => d.date === date)?.debtPaidMinor ?? 0;
    expect(paidOn("2026-10-02")).toBe(0);
    expect(paidOn("2026-10-08")).toBe(25000);
    const summary = async (from: string, to: string, q = "") =>
      (await t.call("get", `/api/calendar/summary?from=${from}&to=${to}${q}`).expect(200)).body
        .debtPaidMinor as number;
    expect(await summary("2026-10-01", "2026-10-05")).toBe(0);
    expect(await summary("2026-10-06", "2026-10-10")).toBe(25000);
    // Looking at the card alone, its own side counts (the paying side is not in view).
    expect(await summary("2026-10-01", "2026-10-05", `&accountId=${card}`)).toBe(25000);
    expect(await summary("2026-10-06", "2026-10-10", `&accountId=${checking}`)).toBe(25000);
  });
});

describe("a benefit payout on a card", () => {
  it("is money in, not debt paid", async () => {
    const { t, card } = await setup();
    const id = (
      await t
        .call("post", "/api/transactions")
        .send({
          accountId: card,
          date: "2026-08-15",
          merchant: "PURCHASE PROTECTION BENEFIT PAYMENT",
          amountMinor: 17888,
          direction: "in",
        })
        .expect(201)
    ).body.id as number;
    t.sqlite
      .prepare(
        "UPDATE transactions SET plaid_category_primary = 'INCOME', name = merchant_name WHERE id = ?",
      )
      .run(id);
    const s = (
      await t.call("get", "/api/calendar/summary?from=2026-08-15&to=2026-08-15").expect(200)
    ).body;
    expect(s.debtPaidMinor).toBe(0);
    expect(s.moneyInMinor).toBe(17888);
  });
});
