import { afterEach, describe, expect, it } from "vitest";
import { accounts, balanceSnapshots, transactions } from "../../drizzle/schema.js";
import { makeTestApp } from "./test-helpers.js";
import { addDays, mondayOf } from "./utils/dates.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
type Ctx = ReturnType<typeof makeTestApp>;
function app(): Ctx {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}

const today = new Date().toISOString().slice(0, 10);
const d = (n: number): string => addDays(today, -n);

function account(
  t: Ctx,
  name: string,
  type: string,
  extra: Partial<typeof accounts.$inferInsert> = {},
) {
  return t.db
    .insert(accounts)
    .values({
      name,
      type,
      currency: "USD",
      isManual: true,
      source: "manual",
      createdAt: "x",
      updatedAt: "x",
      ...extra,
    })
    .returning({ id: accounts.id })
    .get().id;
}
const snapshot = (t: Ctx, accountId: number, day: string, value: number) =>
  t.db
    .insert(balanceSnapshots)
    .values({
      accountId,
      observedAt: `${day}T12:00:00Z`,
      currentBalanceMinor: value,
      availableBalanceMinor: null,
      currency: "USD",
    })
    .run();
let sequence = 0;
const tx = (t: Ctx, accountId: number, day: string, amount: number) =>
  t.db
    .insert(transactions)
    .values({
      accountId,
      plaidTransactionId: `s-${(sequence += 1)}`,
      date: day,
      name: "Something",
      amountMinor: amount,
      currency: "USD",
      createdAt: "x",
      updatedAt: "x",
    })
    .run();
const series = async (t: Ctx, q = "granularity=day") =>
  (await t.call("get", `/api/analytics/net-worth-series?${q}`).expect(200)).body as {
    firstDay: string | null;
    recordedFrom: string | null;
    accountsTotal: number;
    points: Array<{
      date: string;
      periodStart: string;
      assetsMinor: number;
      liabilitiesMinor: number;
      netWorthMinor: number;
      changeMinor: number | null;
      accounts: { recorded: number; rebuilt: number; carried: number };
    }>;
  };
const on = (s: Awaited<ReturnType<typeof series>>, day: string) =>
  s.points.find((p) => p.date === day)!;

describe("net worth series: a cash account", () => {
  it("is wound back from the recorded balance by its own transactions", async () => {
    const t = app();
    const checking = account(t, "Checking", "depository");
    // Recorded today: $1,000.00. A $30 purchase two days ago and a $50 deposit yesterday.
    snapshot(t, checking, today, 100000);
    tx(t, checking, d(2), 3000);
    tx(t, checking, d(1), -5000);
    const s = await series(t);
    expect(s.firstDay).toBe(d(2));
    expect(s.recordedFrom).toBe(today);
    // End of today and yesterday: 1000.00. End of the day before: 950.00 (before the deposit).
    expect(on(s, today).assetsMinor).toBe(100000);
    expect(on(s, d(1)).assetsMinor).toBe(100000);
    expect(on(s, d(2)).assetsMinor).toBe(95000);
    expect(on(s, today).accounts).toEqual({ recorded: 1, rebuilt: 0, carried: 0 });
    expect(on(s, d(1)).accounts).toEqual({ recorded: 0, rebuilt: 1, carried: 0 });
    // Nothing before the account's first transaction is shown.
    expect(s.points.map((p) => p.date)[0]).toBe(d(2));
    expect(on(s, d(1)).changeMinor).toBe(5000);
  });

  it("uses the nearer of two recorded balances, and winds forward from an earlier one", async () => {
    const t = app();
    const checking = account(t, "Checking", "depository");
    snapshot(t, checking, d(4), 80000);
    snapshot(t, checking, d(0), 100000);
    tx(t, checking, d(3), 2000); // out
    tx(t, checking, d(2), -10000); // in
    tx(t, checking, d(1), 8000); // out
    // 80000 on d(4); +2000 out on d(3) -> 78000; +10000 in d(2) -> 88000; 8000 out d(1) -> 80000.
    // The balance recorded today (100000) disagrees, as real data can (an uncounted transaction).
    const s = await series(t);
    // d(3) is nearest to the earlier record (distance 1) and is wound forward from it.
    expect(on(s, d(3)).assetsMinor).toBe(78000);
    // d(1) is nearest to the later record (distance 1) and is wound back from it.
    expect(on(s, d(1)).assetsMinor).toBe(100000);
    expect(on(s, d(3)).accounts.rebuilt).toBe(1);
  });

  it("ignores pending transactions, which are not in the recorded balance yet", async () => {
    const t = app();
    const checking = account(t, "Checking", "depository");
    snapshot(t, checking, today, 50000);
    tx(t, checking, d(2), 1000);
    t.db
      .insert(transactions)
      .values({
        accountId: checking,
        plaidTransactionId: "pending-1",
        date: d(1),
        name: "Pending",
        amountMinor: 9999,
        currency: "USD",
        pending: true,
        createdAt: "x",
        updatedAt: "x",
      })
      .run();
    const s = await series(t);
    expect(on(s, d(2)).assetsMinor).toBe(50000);
  });
});

describe("net worth series: cards, investments, and totals", () => {
  async function scenario() {
    const t = app();
    const checking = account(t, "Checking", "depository", { currentBalanceMinor: 100000 });
    const card = account(t, "Card", "credit", { currentBalanceMinor: 50000 });
    const brokerage = account(t, "Brokerage", "investment", { currentBalanceMinor: 210000 });
    snapshot(t, checking, today, 100000);
    tx(t, checking, d(2), 3000);
    tx(t, checking, d(1), -5000);
    // A card owing $500.00 today, after a $20 purchase yesterday and a $30 payment two days ago.
    snapshot(t, card, today, 50000);
    tx(t, card, d(1), 2000);
    tx(t, card, d(2), -3000);
    snapshot(t, brokerage, d(5), 200000);
    snapshot(t, brokerage, d(1), 210000);
    return { t, checking, card, brokerage };
  }

  it("winds a card's debt back by what was added to it and paid off", async () => {
    const { t } = await scenario();
    const s = await series(t);
    expect(on(s, today).liabilitiesMinor).toBe(50000);
    expect(on(s, d(1)).liabilitiesMinor).toBe(50000);
    expect(on(s, d(2)).liabilitiesMinor).toBe(48000); // before the $20 purchase
  });

  it("carries an investment balance until the next record", async () => {
    const { t } = await scenario();
    const s = await series(t);
    // The brokerage was first recorded d(5), but the series starts where the earliest account does.
    expect(s.firstDay).toBe(d(5));
    // The checking account has no activity yet, so it is held at the balance it started with
    // (98,000.00, before the first transaction); the brokerage is its recorded 200,000.00.
    expect(on(s, d(5)).assetsMinor).toBe(98000 + 200000);
    expect(on(s, d(3)).assetsMinor).toBe(98000 + 200000);
    expect(on(s, d(3)).accounts).toEqual({ recorded: 0, rebuilt: 0, carried: 3 });
    expect(on(s, d(1)).assetsMinor).toBe(100000 + 210000);
    expect(on(s, today).assetsMinor).toBe(100000 + 210000);
  });

  it("totals assets and debts, and the last point is today's net worth", async () => {
    const { t } = await scenario();
    const s = await series(t);
    const last = s.points.at(-1)!;
    expect(last.date).toBe(today);
    expect(last.netWorthMinor).toBe(100000 + 210000 - 50000);
    const overview = (await t.call("get", "/api/analytics/overview").expect(200)).body;
    expect(last.netWorthMinor).toBe(overview.netWorthMinor);
    // The day the card appears, its debt is part of the total, not a hole in it.
    expect(on(s, d(2))).toMatchObject({ assetsMinor: 95000 + 200000, liabilitiesMinor: 48000 });
  });

  it("leaves out a hidden account", async () => {
    const { t, card } = await scenario();
    await t.call("patch", `/api/accounts/${card}`).send({ hidden: true }).expect(200);
    const s = await series(t);
    expect(on(s, today).liabilitiesMinor).toBe(0);
    expect(s.accountsTotal).toBe(2);
  });
});

describe("net worth series: day, week, and month", () => {
  async function longScenario() {
    const t = app();
    const checking = account(t, "Checking", "depository");
    snapshot(t, checking, today, 100000);
    // A $10 outflow every day for 70 days.
    for (let n = 1; n <= 70; n++) tx(t, checking, d(n), 1000);
    return t;
  }

  it("gives one point per day, per week (ending on its last day), or per month", async () => {
    const t = await longScenario();
    const daily = await series(t, "granularity=day");
    // Seventy days back through today.
    expect(daily.points).toHaveLength(71);
    const weekly = await series(t, "granularity=week");
    for (const p of weekly.points.slice(0, -1)) {
      expect(p.date).toBe(addDays(mondayOf(p.date), 6));
    }
    // A week starts on Monday, except the first, which starts where the data does.
    for (const p of weekly.points.slice(1, -1)) expect(p.periodStart).toBe(mondayOf(p.date));
    expect(weekly.points[0]!.periodStart).toBe(weekly.firstDay);
    const monthly = await series(t, "granularity=month");
    expect(monthly.points.length).toBeGreaterThanOrEqual(2);
    expect(monthly.points.length).toBeLessThanOrEqual(4);
    for (const p of monthly.points.slice(0, -1)) {
      expect(p.date).toMatch(/-(28|29|30|31)$/);
    }
  });

  it("every granularity ends today, and a period shows the balance at its END", async () => {
    const t = await longScenario();
    for (const g of ["day", "week", "month"]) {
      const s = await series(t, `granularity=${g}`);
      expect(s.points.at(-1)!.date).toBe(today);
      expect(s.points.at(-1)!.netWorthMinor).toBe(100000);
    }
    const daily = await series(t, "granularity=day");
    const weekly = await series(t, "granularity=week");
    for (const w of weekly.points) {
      // The weekly figure equals the daily figure on the same day.
      expect(w.netWorthMinor).toBe(on(daily, w.date)?.netWorthMinor ?? w.netWorthMinor);
    }
    // Ten dollars a day went out: 70 days back is $700 more than today.
    expect(daily.points[0]!.netWorthMinor).toBe(100000 + 1000 * 69);
  });

  it("changes are the step from the previous point", async () => {
    const t = await longScenario();
    const weekly = await series(t, "granularity=week");
    for (const [i, p] of weekly.points.entries()) {
      if (i === 0) expect(p.changeMinor).toBeNull();
      else expect(p.changeMinor).toBe(p.netWorthMinor - weekly.points[i - 1]!.netWorthMinor);
    }
  });

  it("limits the range with from and to", async () => {
    const t = await longScenario();
    const s = await series(t, `granularity=day&from=${d(10)}&to=${d(5)}`);
    expect(s.points.map((p) => p.date)).toEqual([d(10), d(9), d(8), d(7), d(6), d(5)]);
  });

  it("refuses a bad request, and says there is nothing when there are no accounts", async () => {
    const t = await longScenario();
    await t.call("get", "/api/analytics/net-worth-series?granularity=hour").expect(400);
    await t.call("get", "/api/analytics/net-worth-series?from=2026-02-30").expect(400);
    await t.call("get", `/api/analytics/net-worth-series?from=${today}&to=${d(5)}`).expect(400);
    const blank = app();
    expect(await series(blank)).toMatchObject({ firstDay: null, points: [], accountsTotal: 0 });
  });

  it("will not build an enormous daily series", async () => {
    const t = app();
    const a = account(t, "Old", "investment");
    snapshot(t, a, addDays(today, -2000), 1000);
    await t.call("get", "/api/analytics/net-worth-series?granularity=day").expect(400);
    const monthly = await series(t, "granularity=month");
    expect(monthly.points.length).toBeGreaterThan(60);
  });
});

describe("net worth series: an account first recorded late", () => {
  it("holds an investment at its first recorded balance, so the total does not jump", async () => {
    const t = app();
    const checking = account(t, "Checking", "depository", { currentBalanceMinor: 100000 });
    const brokerage = account(t, "Brokerage", "investment", { currentBalanceMinor: 500000 });
    snapshot(t, checking, today, 100000);
    tx(t, checking, d(5), 1000);
    // Connected only today: nothing was recorded before.
    snapshot(t, brokerage, today, 500000);
    const s = await series(t);
    expect(s.firstDay).toBe(d(5));
    for (const day of [d(4), d(2), today])
      expect(on(s, day).assetsMinor).toBeGreaterThanOrEqual(500000);
    expect(on(s, d(4)).accounts.carried).toBe(1);
    expect(on(s, today).accounts.recorded).toBe(2);
    // No step at the day it was connected: only the checking account's own movement shows.
    expect(on(s, today).changeMinor).toBe(0);
  });
});
