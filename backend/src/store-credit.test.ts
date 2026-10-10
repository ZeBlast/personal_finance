import { afterEach, describe, expect, it } from "vitest";
import { overview } from "./services/analytics.service.js";
import { netWorthHistory } from "./services/networth-history.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const make = async (name: string, kind: string, openingBalanceMinor?: number) =>
    (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name, kind, ...(openingBalanceMinor ? { openingBalanceMinor } : {}) })
        .expect(201)
    ).body.id as number;
  const dunkin = await make("Dunkin", "store_credit", 2_500);
  const wallet = await make("Wallet", "cash", 10_000);
  const balance = async (id: number) =>
    (
      (await t.call("get", "/api/accounts").expect(200)).body as Array<{
        id: number;
        currentBalanceMinor: number;
        subtype: string;
      }>
    ).find((a) => a.id === id)!;
  const spending = async () =>
    (await t.call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30").expect(200)).body
      .totals as { incomeMinor: number; spendingMinor: number };
  return { t, dunkin, wallet, balance, spending };
}

describe("store credit accounts", () => {
  it("hold credits that count only in the account, never in totals", async () => {
    const { t, dunkin, balance, spending } = await setup();
    expect(await balance(dunkin)).toMatchObject({
      currentBalanceMinor: 2_500,
      subtype: "store credit",
    });
    await t
      .call("post", `/api/accounts/${dunkin}/credits/add`)
      .send({ date: "2026-09-05", amountMinor: 1_000, description: "Gift from Sam" })
      .expect(201);
    expect((await balance(dunkin)).currentBalanceMinor).toBe(3_500);
    expect(await balance(dunkin)).toMatchObject({ countsInTotals: false });
    expect(await spending()).toMatchObject({ incomeMinor: 0, spendingMinor: 0 });
    // Net worth includes the credits ($35) with the wallet's $100, as other assets, not cash.
    const o = overview(t.db);
    expect(o.netWorthMinor).toBe(13_500);
    expect(o).toMatchObject({ cashMinor: 10_000, otherAssetsMinor: 3_500 });
    // And the net worth history counts them too.
    const history = netWorthHistory(t.db, {});
    expect(history.points.at(-1)!.netWorthMinor).toBe(13_500);
  });

  it("pay a purchase with credits only", async () => {
    const { t, dunkin, balance, spending } = await setup();
    const r = await t
      .call("post", `/api/accounts/${dunkin}/credits/use`)
      .send({ date: "2026-09-06", totalMinor: 650, creditMinor: 650 })
      .expect(201);
    expect(r.body.rest).toBeNull();
    expect(r.body.credit).toMatchObject({ merchant: "Dunkin", amountMinor: 650 });
    expect((await balance(dunkin)).currentBalanceMinor).toBe(1_850);
    // Not spending anywhere but in the account's own figures.
    expect((await spending()).spendingMinor).toBe(0);
    const own = (
      await t
        .call("get", `/api/analytics/summary?from=2026-09-01&to=2026-09-30&accountId=${dunkin}`)
        .expect(200)
    ).body.totals;
    expect(own.spendingMinor).toBe(650);
    // Left out of the Transactions list, unless the account is chosen.
    const all = (await t.call("get", "/api/transactions?from=2026-09-01&to=2026-09-30").expect(200))
      .body.items as unknown[];
    expect(all).toHaveLength(0);
    const mine = (
      await t
        .call("get", `/api/transactions?from=2026-09-01&to=2026-09-30&accountId=${dunkin}`)
        .expect(200)
    ).body.items as unknown[];
    expect(mine).toHaveLength(1);
  });

  it("split a purchase: only the real money counts as spending", async () => {
    const { t, dunkin, wallet, balance, spending } = await setup();
    const r = await t
      .call("post", `/api/accounts/${dunkin}/credits/use`)
      .send({ date: "2026-09-06", totalMinor: 3_000, creditMinor: 2_500, restAccountId: wallet })
      .expect(201);
    expect(r.body.rest).toMatchObject({ amountMinor: 500 });
    expect(r.body.credit.notes).toContain("$25.00 from Dunkin credits, $5.00 from Wallet");
    expect((await balance(dunkin)).currentBalanceMinor).toBe(0);
    expect((await balance(wallet)).currentBalanceMinor).toBe(9_500);
    expect((await spending()).spendingMinor).toBe(500);
  });

  it("leaves the rest to the bank when a connected card paid it", async () => {
    const { t, dunkin, balance, spending } = await setup();
    const r = await t
      .call("post", `/api/accounts/${dunkin}/credits/use`)
      .send({ date: "2026-09-06", totalMinor: 3_000, creditMinor: 1_000 })
      .expect(201);
    expect(r.body.rest).toBeNull();
    expect(r.body.credit.notes).toContain("from a connected account or card");
    expect((await balance(dunkin)).currentBalanceMinor).toBe(1_500);
    expect((await spending()).spendingMinor).toBe(0);
  });

  it("never pairs with real money as a transfer between your own accounts", async () => {
    const { t, dunkin, wallet } = await setup();
    await t
      .call("post", `/api/accounts/${dunkin}/credits/use`)
      .send({ date: "2026-09-06", totalMinor: 650, creditMinor: 650 })
      .expect(201);
    // Money in on the wallet the same day for the same amount, reading like a transfer.
    const r = await t
      .call("post", "/api/transactions")
      .send({
        accountId: wallet,
        date: "2026-09-06",
        merchant: "Transfer from Dunkin",
        amountMinor: 650,
        direction: "in",
      })
      .expect(201);
    const tx = (await t.call("get", `/api/transactions/${r.body.id}`).expect(200)).body;
    expect(tx.isTransfer).toBe(false);
  });

  it("refuses more credit than is left, and other accounts", async () => {
    const { t, dunkin, wallet, balance } = await setup();
    const tooMuch = await t
      .call("post", `/api/accounts/${dunkin}/credits/use`)
      .send({ date: "2026-09-06", totalMinor: 5_000, creditMinor: 3_000 })
      .expect(409);
    expect(tooMuch.body.message).toContain("only $25.00");
    await t
      .call("post", `/api/accounts/${wallet}/credits/add`)
      .send({ date: "2026-09-06", amountMinor: 100 })
      .expect(409);
    await t
      .call("post", `/api/accounts/${dunkin}/credits/use`)
      .send({ date: "2026-09-06", totalMinor: 500, creditMinor: 600 })
      .expect(400);
    // Nothing was added by the refused requests.
    expect((await balance(dunkin)).currentBalanceMinor).toBe(2_500);
  });
});
