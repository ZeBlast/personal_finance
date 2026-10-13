import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./test-helpers.js";
import {
  createManualBankAccount,
  createManualTransaction,
  repairManualBalanceHistories,
  updateAnyTransaction,
} from "./services/manual-transaction.service.js";
import { netWorthSeries } from "./services/networth-series.service.js";
import {
  periodSummary,
  createPlanned,
  calendarOverlay,
  expectedEvents,
} from "./services/calendar.service.js";
import { calendarForecast, cashForecast } from "./services/forecast.service.js";
import { listBills, setBillSettings } from "./services/bills.service.js";
import { setAccountHidden } from "./services/account.service.js";
import { summarize } from "./services/analytics.service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const TODAY = "2026-10-09";
const NOW = `${TODAY}T12:00:00Z`;
function setup(kind: "cash" | "credit_card" | "store_credit" = "cash") {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const accountId = createManualBankAccount(
    t.db,
    { name: "Manual", kind, openingBalanceMinor: 10000 },
    "2026-10-01T12:00:00Z",
  );
  const pending = (date = "2026-10-12", amountMinor = 1000, direction: "out" | "in" = "out") =>
    createManualTransaction(
      t.db,
      { accountId, date, merchant: "Coffee", amountMinor, direction, pending: true },
      NOW,
    );
  const balance = () =>
    (
      t.sqlite
        .prepare("select current_balance_minor as balance from accounts where id = ?")
        .get(accountId) as { balance: number }
    ).balance;
  const summary = (from: string, to: string) =>
    periodSummary(t.db, from, to, accountId, "fake", TODAY);
  return { ...t, accountId, pending, balance, summary };
}

describe("pending manual transactions", () => {
  it("leaves history unchanged but counts future charges in spending and calendar projections", () => {
    const t = setup();
    t.pending("2026-10-05"); // still outstanding
    t.pending("2026-10-12", 2000);
    t.pending("2026-11-12", 4000); // outside the requested period
    expect(t.balance()).toBe(10000);
    const history = netWorthSeries(t.db, {
      granularity: "day",
      from: "2026-10-01",
      to: TODAY,
      today: TODAY,
    });
    expect(history.points.every((p) => p.assetsMinor === 10000)).toBe(true);
    expect(t.summary("2026-10-02", "2026-10-02").balance).toMatchObject({
      startMinor: 10000,
      endMinor: 10000,
    });
    expect(t.summary("2026-10-12", "2026-10-12")).toMatchObject({
      balance: { startMinor: 9000, endMinor: 7000, projected: true },
      spendingMinor: 2000,
      pendingCount: 1,
      expected: { count: 1, outflowMinor: 2000, inflowMinor: 0 },
    });
    const spending = summarize(t.db, {
      from: "2026-10-10",
      to: "2026-10-20",
      groupBy: "none",
      environment: "fake",
      includePending: true,
      includeTransfers: false,
      fill: false,
    });
    expect(spending.totals.spendingMinor).toBe(2000);
    const postedOnly = summarize(t.db, {
      from: "2026-10-10",
      to: "2026-10-20",
      groupBy: "none",
      environment: "fake",
      includePending: false,
      includeTransfers: false,
      fill: false,
    });
    expect(postedOnly.totals.spendingMinor).toBe(0);
    const overlay = calendarOverlay(t.db, "2026-10", t.accountId, TODAY).expected;
    expect(overlay.find((d) => d.date === "2026-10-12")).toMatchObject({
      date: "2026-10-12",
      count: 1,
      outflowMinor: 2000,
      inflowMinor: 0,
    });
    // The outstanding entry from Oct 5 is carried forward to tomorrow, not left on its own day.
    expect(overlay.find((d) => d.date === "2026-10-05")).toBeUndefined();
    expect(overlay.find((d) => d.date === "2026-10-10")).toMatchObject({ count: 1 });
  });

  it("splits the balance into cash, card debt and the two together, now and projected", () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const made = "2026-10-01T12:00:00Z";
    createManualBankAccount(
      t.db,
      { name: "Checking", kind: "cash", openingBalanceMinor: 100000 },
      made,
    );
    const card = createManualBankAccount(
      t.db,
      { name: "Card", kind: "credit_card", openingBalanceMinor: 20000 },
      made,
    );
    const now = periodSummary(t.db, TODAY, TODAY, undefined, "fake", TODAY).balance;
    expect(now).toMatchObject({
      endMinor: 80000,
      cash: { endMinor: 100000 },
      cardDebt: { endMinor: 20000 },
      projection: null,
    });
    expect(now.accounts.map((a) => a.name).sort()).toEqual(["Card", "Checking"]);
    // A pending card purchase adds to the card debt; cash stays where it is until the bill is paid.
    createManualTransaction(
      t.db,
      {
        accountId: card,
        date: "2026-10-12",
        merchant: "Shoes",
        amountMinor: 5000,
        direction: "out",
        pending: true,
      },
      NOW,
    );
    const later = periodSummary(t.db, "2026-10-12", "2026-10-12", undefined, "fake", TODAY).balance;
    expect(later).toMatchObject({
      endMinor: 75000,
      cash: { endMinor: 100000 },
      cardDebt: { endMinor: 25000 },
      projection: { todayMinor: 80000, inMinor: 0, outMinor: 5000 },
    });
  });

  it("lists the same expected items the totals count, each once, carried forward when overdue", () => {
    const t = setup();
    t.pending("2026-10-05");
    t.pending("2026-10-12", 2000);
    // A plan the Oct 12 entry already stands for, and one it does not.
    for (const [merchant, amountMinor] of [
      ["Coffee", 2000],
      ["Rent", 50000],
    ] as const) {
      createPlanned(
        t.db,
        {
          merchant,
          amountMinor,
          direction: "out",
          accountId: t.accountId,
          startDate: "2026-10-12",
          frequency: "once",
        },
        NOW,
      );
    }
    const events = expectedEvents(t.db, "2026-10-10", "2026-10-12", { today: TODAY });
    expect(
      events.map((e) => [e.source, e.date, e.originalDate, e.merchant, e.amountMinor]),
    ).toEqual([
      ["pending", "2026-10-10", "2026-10-05", "Coffee", 1000],
      ["pending", "2026-10-12", "2026-10-12", "Coffee", 2000],
      ["planned", "2026-10-12", "2026-10-12", "Rent", 50000],
    ]);
    const s = t.summary("2026-10-10", "2026-10-12");
    expect(s.expected).toEqual({ count: 3, outflowMinor: 53000, inflowMinor: 0 });
    // The matched plan and its pending entry move the balance once.
    expect(s.balance.endMinor).toBe(10000 - 1000 - 2000 - 50000);
  });

  it("gives the calendar the forecast's cash for the days ahead in a span, and nothing before", () => {
    const t = setup();
    t.pending("2026-10-05");
    t.pending("2026-10-12", 2000);
    const f = calendarForecast(t.db, "2026-10-01", "2026-10-31", TODAY);
    expect(f.days[0]!.date).toBe("2026-10-10");
    expect(f.days.at(-1)!.date).toBe("2026-10-31");
    expect(f.days.find((d) => d.date === "2026-10-10")).toMatchObject({ cashMinor: 9000 });
    expect(f.days.find((d) => d.date === "2026-10-12")).toMatchObject({
      cashMinor: 7000,
      events: [{ label: "Coffee", amountMinor: -2000, source: "pending" }],
    });
    // Agrees with the forecast itself.
    const full = cashForecast(t.db, { today: TODAY, days: 22 });
    expect(full.days.find((d) => d.date === "2026-10-31")!.balanceMinor).toBe(
      f.days.at(-1)!.cashMinor,
    );
    expect(calendarForecast(t.db, "2026-09-01", "2026-09-30", TODAY).days).toEqual([]);
  });

  it("forecasts outstanding and future charges once, and excludes entries outside the forecast", () => {
    const t = setup();
    t.pending("2026-10-05");
    t.pending("2026-10-12", 2000);
    t.pending("2026-11-12", 4000);
    const forecast = cashForecast(t.db, { today: TODAY, days: 7 });
    expect(forecast.startBalanceMinor).toBe(10000);
    expect(forecast.endBalanceMinor).toBe(7000);
    expect(forecast.days.find((d) => d.date === "2026-10-10")!.events).toEqual([
      { label: "Coffee", amountMinor: -1000, source: "pending" },
    ]);
    expect(forecast.days.find((d) => d.date === "2026-10-12")!.changeMinor).toBe(-2000);
    const charge = t.sqlite
      .prepare("select id from transactions where pending = 1 and date = ?")
      .get("2026-10-12") as { id: number };
    updateAnyTransaction(t.db, charge.id, { pending: false, date: TODAY }, NOW);
    expect(t.balance()).toBe(8000);
    expect(cashForecast(t.db, { today: TODAY, days: 7 }).endBalanceMinor).toBe(7000);
  });

  it("projects pending deposits and keeps hidden accounts and store credits out of cash forecasts", () => {
    const t = setup();
    t.pending("2026-10-12", 2000, "in");
    const gift = createManualBankAccount(
      t.db,
      { name: "Gift", kind: "store_credit", openingBalanceMinor: 5000 },
      NOW,
    );
    createManualTransaction(
      t.db,
      {
        accountId: gift,
        date: "2026-10-12",
        merchant: "Gift charge",
        amountMinor: 3000,
        direction: "out",
        pending: true,
      },
      NOW,
    );
    expect(cashForecast(t.db, { today: TODAY, days: 7 }).endBalanceMinor).toBe(12000);
    setAccountHidden(t.db, t.accountId, true);
    expect(cashForecast(t.db, { today: TODAY, days: 7 }).endBalanceMinor).toBe(0);
  });

  it("includes pending card charges in the next bill and projected debt, without changing the closed statement", () => {
    const t = setup("credit_card");
    t.pending("2026-10-05", 1000);
    t.pending("2026-10-12", 2000);
    t.pending("2026-11-12", 4000);
    setBillSettings(
      t.db,
      t.accountId,
      { closingDay: 5, dueDay: 20, minimumMinor: null, autopay: false },
      NOW,
    );
    expect(t.balance()).toBe(10000);
    const bill = listBills(t.db, TODAY).find((b) => b.accountId === t.accountId)!;
    expect(bill.statement!.balanceMinor).toBe(10000);
    expect(bill.next!.balanceSoFarMinor).toBe(3000);
    expect(t.summary("2026-10-12", "2026-10-12").debt.endMinor).toBe(13000);
    createManualBankAccount(
      t.db,
      { name: "Checking", kind: "cash", openingBalanceMinor: 20000 },
      NOW,
    );
    const forecast = cashForecast(t.db, { today: TODAY, days: 90 });
    expect(forecast.days.find((d) => d.date === "2026-11-20")!.changeMinor).toBe(-3000);
    expect(forecast.days.find((d) => d.date === "2026-12-20")!.changeMinor).toBe(-4000);
    expect(forecast.endBalanceMinor).toBe(3000);
  });

  it("repairs old balances that included pending entries and keeps repair idempotent", () => {
    const t = setup();
    t.pending("2026-10-05");
    t.sqlite
      .prepare("update accounts set current_balance_minor = 9000 where id = ?")
      .run(t.accountId);
    t.sqlite
      .prepare("update balance_snapshots set current_balance_minor = 9000 where account_id = ?")
      .run(t.accountId);
    repairManualBalanceHistories(t.db);
    repairManualBalanceHistories(t.db);
    expect(t.balance()).toBe(10000);
    expect(
      netWorthSeries(t.db, {
        granularity: "day",
        from: "2026-10-01",
        to: TODAY,
        today: TODAY,
      }).points.every((p) => p.assetsMinor === 10000),
    ).toBe(true);
  });

  it("does not count a pending charge again when it matches a planned occurrence", () => {
    const t = setup();
    t.pending();
    createPlanned(
      t.db,
      {
        merchant: "Coffee",
        amountMinor: 1000,
        direction: "out",
        accountId: t.accountId,
        startDate: "2026-10-12",
        frequency: "once",
      },
      NOW,
    );
    const forecast = cashForecast(t.db, { today: TODAY, days: 7 });
    expect(forecast.endBalanceMinor).toBe(9000);
    expect(forecast.days.find((d) => d.date === "2026-10-12")!.events).toHaveLength(1);
    expect(t.summary("2026-10-12", "2026-10-12").balance.endMinor).toBe(9000);
  });
});
