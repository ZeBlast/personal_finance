import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}
type T = ReturnType<typeof app>;

async function category(t: T, name: string, parentId?: number) {
  return (
    await t
      .call("post", "/api/categories")
      .send({ name, ...(parentId ? { parentId } : {}) })
      .expect(201)
  ).body.id as number;
}
async function card(t: T, name = "Rewards Card") {
  return (
    await t.call("post", "/api/accounts/manual").send({ name, kind: "credit_card" }).expect(201)
  ).body.id as number;
}
const buy = (
  t: T,
  accountId: number,
  merchant: string,
  amountMinor: number,
  categoryId?: number,
  extra: Record<string, unknown> = {},
) =>
  t
    .call("post", "/api/transactions")
    .send({
      accountId,
      date: "2026-09-10",
      merchant,
      amountMinor,
      direction: "out",
      ...(categoryId ? { categoryId } : {}),
      ...extra,
    })
    .expect(201);
const rates = (t: T, accountId: number, rules: Array<Record<string, unknown>>) =>
  t.call("put", `/api/accounts/${accountId}/cashback-rules`).send({ rules });
const summary = async (t: T, q = "from=2026-09-01&to=2026-09-30") =>
  (await t.call("get", `/api/cashback/summary?${q}`).expect(200)).body as {
    totalCashbackMinor: number;
    cards: Array<{
      accountId: number;
      cashbackMinor: number;
      spendMinor: number;
      hasRates: boolean;
      buckets: Array<{
        label: string;
        rateBps: number | null;
        spendMinor: number;
        cashbackMinor: number;
      }>;
    }>;
  };

describe("cashback rates on a card", () => {
  it("saves rates by category and for everything else, and reads them back", async () => {
    const t = app();
    const id = await card(t);
    const groceries = await category(t, "Groceries Test");
    const res = await rates(t, id, [
      { categoryId: groceries, ratePercent: 5 },
      { categoryId: null, ratePercent: 1.5 },
    ]).expect(200);
    expect(res.body).toEqual([
      {
        categoryId: groceries,
        categoryName: "Groceries Test",
        ratePercent: 5,
        onlineOnly: false,
        merchant: null,
        exclude: false,
      },
      {
        categoryId: null,
        categoryName: null,
        ratePercent: 1.5,
        onlineOnly: false,
        merchant: null,
        exclude: false,
      },
    ]);
    expect(
      (await t.call("get", `/api/accounts/${id}/cashback-rules`).expect(200)).body,
    ).toHaveLength(2);
    // Saving again replaces the set.
    await rates(t, id, [{ categoryId: null, ratePercent: 2 }]).expect(200);
    expect((await t.call("get", `/api/accounts/${id}/cashback-rules`)).body).toEqual([
      {
        categoryId: null,
        categoryName: null,
        ratePercent: 2,
        onlineOnly: false,
        merchant: null,
        exclude: false,
      },
    ]);
    await rates(t, id, []).expect(200);
    expect((await t.call("get", `/api/accounts/${id}/cashback-rules`)).body).toEqual([]);
  });

  it("refuses bad rates, a repeated category, an unknown category, and a card that is not a card", async () => {
    const t = app();
    const id = await card(t);
    const c = await category(t, "Dining Test");
    await rates(t, id, [{ categoryId: null, ratePercent: -1 }]).expect(400);
    await rates(t, id, [{ categoryId: null, ratePercent: 101 }]).expect(400);
    await rates(t, id, [{ categoryId: null, ratePercent: 1.234 }]).expect(400);
    await rates(t, id, [
      { categoryId: c, ratePercent: 2 },
      { categoryId: c, ratePercent: 3 },
    ]).expect(400);
    await rates(t, id, [
      { categoryId: null, ratePercent: 1 },
      { categoryId: null, ratePercent: 2 },
    ]).expect(400);
    await rates(t, id, [{ categoryId: 99999, ratePercent: 2 }]).expect(400);
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    await rates(t, checking, [{ categoryId: null, ratePercent: 1 }]).expect(409);
    await rates(t, 99999, []).expect(404);
  });

  it("is removed with the card", async () => {
    const t = app();
    const id = await card(t);
    await rates(t, id, [{ categoryId: null, ratePercent: 1 }]).expect(200);
    await t.call("delete", `/api/accounts/manual/${id}`).expect(204);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM cashback_rules").get()).toEqual({ n: 0 });
  });
});

describe("what a card has earned", () => {
  async function scenario() {
    const t = app();
    const id = await card(t);
    const groceries = await category(t, "Groceries Test");
    const organic = await category(t, "Organic Test", groceries);
    const gas = await category(t, "Gas Test");
    const shopping = await category(t, "Shopping Test");
    await rates(t, id, [
      { categoryId: groceries, ratePercent: 5 },
      { categoryId: gas, ratePercent: 3 },
      { categoryId: null, ratePercent: 1 },
    ]).expect(200);
    return { t, id, groceries, organic, gas, shopping };
  }

  it("applies the category's rate, then the parent's, then the rate for everything else", async () => {
    const { t, id, groceries, organic, gas, shopping } = await scenario();
    await buy(t, id, "Market", 10000, groceries); // 5% of $100.00 = $5.00
    await buy(t, id, "Farm stand", 4000, organic); // sub-category uses its parent's 5% = $2.00
    await buy(t, id, "Shell", 4000, gas); // 3% of $40.00 = $1.20
    await buy(t, id, "Mall", 5000, shopping); // everything else 1% = $0.50
    await buy(t, id, "Mystery", 1234); // no category: everything else 1% = $0.12
    const s = await summary(t);
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]).toMatchObject({
      accountId: id,
      hasRates: true,
      spendMinor: 10000 + 4000 + 4000 + 5000 + 1234,
      cashbackMinor: 500 + 200 + 120 + 50 + 12,
    });
    expect(s.totalCashbackMinor).toBe(882);
    const byLabel = Object.fromEntries(s.cards[0]!.buckets.map((b) => [b.label, b]));
    expect(byLabel["Groceries Test"]).toMatchObject({
      rateBps: 500,
      spendMinor: 14000,
      cashbackMinor: 700,
    });
    expect(byLabel["Gas Test"]).toMatchObject({ rateBps: 300, cashbackMinor: 120 });
    expect(byLabel["Everything else"]).toMatchObject({
      rateBps: 100,
      spendMinor: 6234,
      cashbackMinor: 62,
    });
  });

  it("takes cashback back on a refund, and ignores card payments and transfers", async () => {
    const { t, id, groceries } = await scenario();
    await buy(t, id, "Market", 10000, groceries); // +5.00
    await buy(t, id, "Market refund", 2000, groceries, { direction: "in" }); // -1.00
    await buy(t, id, "Payment thank you", 5000, undefined, { direction: "in" }); // a payment, not a refund
    await buy(t, id, "Moved money", 3000, undefined, { isTransfer: true });
    const s = await summary(t);
    expect(s.cards[0]).toMatchObject({ spendMinor: 8000, cashbackMinor: 400 });
  });

  it("counts a card with no rates as spend without a rate, so it is easy to see what to set up", async () => {
    const t = app();
    const id = await card(t);
    await buy(t, id, "Market", 10000);
    const s = await summary(t);
    expect(s.cards[0]).toMatchObject({ hasRates: false, cashbackMinor: 0, spendMinor: 10000 });
    expect(s.cards[0]!.buckets).toEqual([
      {
        categoryId: null,
        merchant: null,
        online: false,
        label: "No rate set",
        rateBps: null,
        spendMinor: 10000,
        cashbackMinor: 0,
      },
    ]);
  });

  it("only counts purchases in the period, and can be limited to one card", async () => {
    const { t, id } = await scenario();
    await buy(t, id, "Early", 10000, undefined, { date: "2026-08-31" });
    await buy(t, id, "In September", 10000);
    await buy(t, id, "Late", 10000, undefined, { date: "2026-10-01" });
    expect((await summary(t)).cards[0]!.cashbackMinor).toBe(100);
    expect((await summary(t, "from=2026-08-01&to=2026-10-31")).cards[0]!.cashbackMinor).toBe(300);
    const other = await card(t, "Second Card");
    await buy(t, other, "Thing", 10000);
    const only = await summary(t, `from=2026-09-01&to=2026-09-30&accountId=${other}`);
    expect(only.cards.map((c) => c.accountId)).toEqual([other]);
  });

  it("leaves out a hidden card, and anything that is not a credit card", async () => {
    const { t, id } = await scenario();
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    await buy(t, checking, "Cafe", 1000);
    await buy(t, id, "Store", 10000);
    expect((await summary(t)).cards.map((c) => c.accountId)).toEqual([id]);
    await t.call("patch", `/api/accounts/${id}`).send({ hidden: true }).expect(200);
    expect((await summary(t)).cards).toEqual([]);
  });

  it("rejects a bad request", async () => {
    const t = app();
    await t.call("get", "/api/cashback/summary?from=2026-09-30&to=2026-09-01").expect(400);
    await t.call("get", "/api/cashback/summary?from=2026-02-30&to=2026-09-01").expect(400);
    await t.call("get", "/api/cashback/summary").expect(400);
  });
});

describe("online purchases", () => {
  async function setup() {
    const t = app();
    const id = await card(t, "Customized Cash");
    const shopping = await category(t, "Online shopping");
    const groceries = await category(t, "Groceries");
    return { t, id, shopping, groceries };
  }
  const first = async (t: T, id: number, merchant: string) => {
    const list = (await t.call("get", `/api/transactions?accountId=${id}&pageSize=200`).expect(200))
      .body.items as Array<{ id: number; merchant: string }>;
    return list.find((x) => x.merchant === merchant)!.id;
  };

  it("pays the online rate only on purchases that were online, and the higher of the two", async () => {
    const { t, id, groceries } = await setup();
    await buy(t, id, "Web shop", 10000);
    await buy(t, id, "Corner shop", 10000);
    await buy(t, id, "Web grocer", 10000, groceries);
    await rates(t, id, [
      { categoryId: null, ratePercent: 1 },
      { categoryId: groceries, ratePercent: 2 },
      { categoryId: null, ratePercent: 3, onlineOnly: true },
    ]).expect(200);
    for (const m of ["Web shop", "Web grocer"]) {
      const txId = await first(t, id, m);
      await t.call("patch", `/api/transactions/${txId}`).send({ online: true }).expect(200);
    }
    const card = (await summary(t)).cards[0]!;
    // Web shop 3% (online beats 1%), Corner shop 1%, Web grocer 3% (online beats the 2% grocery rate).
    expect(card.cashbackMinor).toBe(300 + 100 + 300);
    expect(card.buckets.map((b) => b.label).sort()).toEqual([
      "Everything else",
      "Everything else (online)",
    ]);
  });

  it("keeps a lower online rate from lowering what a purchase would earn anyway", async () => {
    const { t, id } = await setup();
    await buy(t, id, "Web shop", 10000);
    await rates(t, id, [
      { categoryId: null, ratePercent: 2 },
      { categoryId: null, ratePercent: 1, onlineOnly: true },
    ]).expect(200);
    await t
      .call("patch", `/api/transactions/${await first(t, id, "Web shop")}`)
      .send({ online: true });
    expect((await summary(t)).cards[0]!.cashbackMinor).toBe(200);
  });

  it("can give an online rate to one category", async () => {
    const { t, id, shopping } = await setup();
    await buy(t, id, "Web shop", 10000, shopping);
    await buy(t, id, "Mall shop", 10000, shopping);
    await rates(t, id, [
      { categoryId: null, ratePercent: 1 },
      { categoryId: shopping, ratePercent: 3, onlineOnly: true },
    ]).expect(200);
    await t
      .call("patch", `/api/transactions/${await first(t, id, "Web shop")}`)
      .send({ online: true });
    const card = (await summary(t)).cards[0]!;
    // The shopping category has no ordinary rate, so the mall purchase falls back to 1%.
    expect(card.cashbackMinor).toBe(300 + 100);
    expect(card.buckets.map((b) => b.label).sort()).toEqual([
      "Everything else",
      "Online shopping (online)",
    ]);
  });

  it("follows the bank's payment channel until the user decides, and then the user", async () => {
    const { t, id } = await setup();
    await buy(t, id, "Web shop", 10000);
    await rates(t, id, [
      { categoryId: null, ratePercent: 1 },
      { categoryId: null, ratePercent: 3, onlineOnly: true },
    ]).expect(200);
    const txId = await first(t, id, "Web shop");
    const channel = (value: string | null) =>
      t.sqlite.prepare("UPDATE transactions SET payment_channel = ? WHERE id = ?").run(value, txId);
    const read = async () =>
      (await t.call("get", `/api/transactions/${txId}`).expect(200)).body as {
        online: boolean;
        onlineEdited: boolean;
        providerOnline: boolean | null;
      };

    expect(await read()).toMatchObject({
      online: false,
      onlineEdited: false,
      providerOnline: null,
    });
    channel("online");
    expect(await read()).toMatchObject({ online: true, onlineEdited: false, providerOnline: true });
    expect((await summary(t)).cards[0]!.cashbackMinor).toBe(300);

    await t.call("patch", `/api/transactions/${txId}`).send({ online: false }).expect(200);
    expect(await read()).toMatchObject({ online: false, onlineEdited: true, providerOnline: true });
    expect((await summary(t)).cards[0]!.cashbackMinor).toBe(100);

    // The bank's value is kept apart, so a later change of it does not undo the user's call.
    channel("in store");
    expect(await read()).toMatchObject({
      online: false,
      onlineEdited: true,
      providerOnline: false,
    });

    await t.call("patch", `/api/transactions/${txId}`).send({ online: null }).expect(200);
    channel("online");
    expect(await read()).toMatchObject({ online: true, onlineEdited: false });
  });

  it("filters the transaction list by online, by the user's call or the bank's", async () => {
    const { t, id } = await setup();
    await buy(t, id, "Bank says online", 1000);
    await buy(t, id, "User says online", 2000);
    await buy(t, id, "User says not online", 3000);
    await buy(t, id, "Neither", 4000);
    t.sqlite
      .prepare(
        "UPDATE transactions SET payment_channel = 'online' WHERE merchant_name = ? OR name = ?",
      )
      .run("Bank says online", "Bank says online");
    t.sqlite
      .prepare("UPDATE transactions SET payment_channel = 'online' WHERE name = ?")
      .run("User says not online");
    await t
      .call("patch", `/api/transactions/${await first(t, id, "User says online")}`)
      .send({ online: true });
    await t
      .call("patch", `/api/transactions/${await first(t, id, "User says not online")}`)
      .send({ online: false });
    const names = async (online: string) =>
      (
        (await t.call("get", `/api/transactions?accountId=${id}&online=${online}`).expect(200)).body
          .items as Array<{ merchant: string }>
      )
        .map((x) => x.merchant)
        .sort();
    expect(await names("true")).toEqual(["Bank says online", "User says online"]);
    expect(await names("false")).toEqual(["Neither", "User says not online"]);
  });

  it("allows one ordinary and one online rate per category, but not two of the same kind", async () => {
    const { t, id, groceries } = await setup();
    await rates(t, id, [
      { categoryId: groceries, ratePercent: 2 },
      { categoryId: groceries, ratePercent: 3, onlineOnly: true },
    ]).expect(200);
    const dup = await rates(t, id, [
      { categoryId: groceries, ratePercent: 2, onlineOnly: true },
      { categoryId: groceries, ratePercent: 3, onlineOnly: true },
    ]).expect(400);
    expect(dup.body.error).toBe("duplicate_rate");
    const saved = (await t.call("get", `/api/accounts/${id}/cashback-rules`).expect(200)).body;
    expect(saved).toHaveLength(2);
    expect(saved.map((r: { onlineOnly: boolean }) => r.onlineOnly)).toEqual([false, true]);
  });
});

describe("merchant rules", () => {
  it("leaves an excluded merchant out of a category, falling back to everything else", async () => {
    const t = app();
    const id = await card(t);
    const groceries = await category(t, "Grocery stores");
    await buy(t, id, "Fresh Market", 10000, groceries);
    await buy(t, id, "WALMART SUPERCENTER #12", 10000, groceries);
    await rates(t, id, [
      { categoryId: groceries, ratePercent: 3 },
      { categoryId: null, ratePercent: 1 },
      { categoryId: groceries, merchant: "walmart", exclude: true, ratePercent: 0 },
    ]).expect(200);
    const c = (await summary(t)).cards[0]!;
    expect(c.cashbackMinor).toBe(300 + 100);
  });

  it("can exclude a merchant from every rate", async () => {
    const t = app();
    const id = await card(t);
    await buy(t, id, "Gift card mall", 10000);
    await rates(t, id, [
      { categoryId: null, ratePercent: 2 },
      { categoryId: null, merchant: "gift card", exclude: true, ratePercent: 0 },
    ]).expect(200);
    expect((await summary(t)).cards[0]!.cashbackMinor).toBe(0);
  });

  it("gives a merchant its own rate whatever its category, and labels it", async () => {
    const t = app();
    const id = await card(t);
    const dining = await category(t, "Dining out");
    await buy(t, id, "Costco Wholesale", 10000, dining);
    await rates(t, id, [
      { categoryId: dining, ratePercent: 3 },
      { categoryId: null, merchant: "Costco", ratePercent: 2 },
    ]).expect(200);
    const c = (await summary(t)).cards[0]!;
    expect(c.cashbackMinor).toBe(200);
    expect(c.buckets[0]!.label).toBe("Merchant “Costco”");
    const saved = (await t.call("get", `/api/accounts/${id}/cashback-rules`).expect(200)).body;
    expect(saved[1]).toMatchObject({ merchant: "Costco", exclude: false, categoryId: null });
  });

  it("refuses an exclusion without a merchant", async () => {
    const t = app();
    const id = await card(t);
    const res = await rates(t, id, [{ categoryId: null, exclude: true, ratePercent: 0 }]).expect(
      400,
    );
    expect(res.body.error).toBe("invalid_rule");
  });
});

describe("was the best card used", () => {
  async function wallet() {
    const t = app();
    const good = await card(t, "Grocery Card");
    const plain = await card(t, "Plain Card");
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const groceries = await category(t, "Grocery stores");
    await rates(t, good, [{ categoryId: groceries, ratePercent: 3 }]).expect(200);
    await rates(t, plain, [{ categoryId: null, ratePercent: 1 }]).expect(200);
    return { t, good, plain, checking, groceries };
  }
  const listed = async (t: T) =>
    (await t.call("get", "/api/transactions?pageSize=200").expect(200)).body.items as Array<{
      merchant: string;
      cashback: {
        status: string;
        cashbackMinor: number;
        bestRateBps: number;
        bestCard: string | null;
      } | null;
    }>;

  it("marks the best card green, another card yellow, and a debit purchase red", async () => {
    const { t, good, plain, checking, groceries } = await wallet();
    await buy(t, good, "Market A", 10000, groceries);
    await buy(t, plain, "Market B", 10000, groceries);
    await buy(t, checking, "Market C", 10000, groceries);
    await buy(t, plain, "Hardware", 10000);
    const by = new Map((await listed(t)).map((x) => [x.merchant, x.cashback]));
    expect(by.get("Market A")).toMatchObject({ status: "best", cashbackMinor: 300 });
    expect(by.get("Market B")).toMatchObject({
      status: "card",
      cashbackMinor: 100,
      bestCard: "Grocery Card",
    });
    expect(by.get("Market C")).toMatchObject({
      status: "missed",
      cashbackMinor: 0,
      bestRateBps: 300,
    });
    // The plain card is the only one that pays for hardware.
    expect(by.get("Hardware")).toMatchObject({ status: "best", cashbackMinor: 100 });
  });

  it("leaves out refunds, transfers, and payments to people", async () => {
    const { t, checking } = await wallet();
    await buy(t, checking, "Refund", 1000, undefined, { direction: "in" });
    await buy(t, checking, "Zelle", 1000, undefined, { recipient: "Sam" });
    const by = new Map((await listed(t)).map((x) => [x.merchant, x.cashback]));
    expect(by.get("Refund")).toBeNull();
    expect(by.get("Zelle")).toBeNull();
  });

  it("never adds cashback to a balance", async () => {
    const { t, good, groceries } = await wallet();
    await buy(t, good, "Market", 10000, groceries);
    const before = (await t.call("get", "/api/accounts").expect(200)).body;
    await listed(t);
    await t.call("get", "/api/cashback/summary?from=2026-09-01&to=2026-09-30").expect(200);
    expect((await t.call("get", "/api/accounts").expect(200)).body).toEqual(before);
  });

  it("filters the list by institution, or by accounts kept by hand", async () => {
    const { t, good } = await wallet();
    await buy(t, good, "Market", 1000);
    const manual = (await t.call("get", "/api/transactions?institution=manual").expect(200)).body;
    expect(manual.total).toBe(1);
    const none = (await t.call("get", "/api/transactions?institution=Nowhere%20Bank").expect(200))
      .body;
    expect(none.total).toBe(0);
  });
});
