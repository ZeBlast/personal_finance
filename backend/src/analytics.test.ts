import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  budgets,
  creditLimitHistory,
  dashboardWidgets,
  transactions,
} from "../../drizzle/schema.js";
import { seedDefaults } from "./services/category.service.js";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";

type Ctx = ReturnType<typeof makeTestApp>;

// ---- helpers to build exact scenarios -----------------------------------------------------

function addAccount(ctx: Ctx, over: Partial<typeof accounts.$inferInsert> = {}): number {
  return ctx.db
    .insert(accounts)
    .values({
      name: "Manual Checking",
      type: "depository",
      subtype: "checking",
      currency: "USD",
      currentBalanceMinor: 100000,
      isManual: true,
      source: "manual",
      color: "#112233",
      createdAt: "x",
      updatedAt: "x",
      ...over,
    })
    .returning({ id: accounts.id })
    .get().id;
}

interface Tx {
  date: string;
  amount: number;
  name?: string;
  merchant?: string | null;
  primary?: string | null;
  detailed?: string | null;
  pending?: boolean;
  transfer?: boolean;
  categoryId?: number | null;
  merchantUser?: string | null;
}

let sequence = 0;
function addTx(ctx: Ctx, accountId: number, t: Tx): number {
  sequence += 1;
  return ctx.db
    .insert(transactions)
    .values({
      accountId,
      plaidTransactionId: `scenario-${sequence}`,
      date: t.date,
      name: t.name ?? "Something",
      merchantName: t.merchant ?? null,
      merchantNameUser: t.merchantUser ?? null,
      amountMinor: t.amount,
      currency: "USD",
      pending: t.pending ?? false,
      plaidCategoryPrimary: t.primary ?? null,
      plaidCategoryDetailed: t.detailed ?? null,
      isTransfer: t.transfer ?? false,
      categoryId: t.categoryId ?? null,
      categorySource: t.categoryId ? "manual" : null,
      createdAt: "x",
      updatedAt: "x",
    })
    .returning({ id: transactions.id })
    .get().id;
}

const makeCategory = async (ctx: Ctx, name: string, parentId?: number) =>
  (
    await ctx
      .call("post", "/api/categories")
      .send({ name, ...(parentId ? { parentId } : {}) })
      .expect(201)
  ).body as {
    id: number;
  };

const summary = async (ctx: Ctx, query: string, expected = 200) =>
  (await ctx.call("get", `/api/analytics/summary?${query}`).expect(expected)).body;

/** September 2026, with every case the definitions have to get right. */
async function scenario(ctx: Ctx) {
  const groceries = await makeCategory(ctx, "Groceries");
  const shopping = await makeCategory(ctx, "Shopping");
  const account = addAccount(ctx);
  const ids = {
    t1: addTx(ctx, account, {
      date: "2026-09-02",
      amount: 100000,
      merchant: "Whole Foods",
      primary: "FOOD_AND_DRINK",
      detailed: "FOOD_AND_DRINK_GROCERIES",
      categoryId: groceries.id,
    }),
    t2: addTx(ctx, account, {
      date: "2026-09-05",
      amount: -30000,
      name: "WHOLE FOODS REFUND",
      merchant: "WHOLE FOODS ",
      primary: "FOOD_AND_DRINK",
      categoryId: groceries.id,
    }),
    t3: addTx(ctx, account, {
      date: "2026-09-10",
      amount: -500000,
      merchant: "ACME Payroll",
      primary: "INCOME",
      detailed: "INCOME_WAGES",
    }),
    t4: addTx(ctx, account, {
      date: "2026-09-12",
      amount: 200000,
      name: "Zelle payment to Jane",
      primary: "TRANSFER_OUT",
      transfer: true,
    }),
    t5: addTx(ctx, account, {
      date: "2026-09-15",
      amount: 50000,
      name: "PAYMENT THANK YOU",
      primary: "LOAN_PAYMENTS",
      detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    }),
    t6: addTx(ctx, account, {
      date: "2026-09-20",
      amount: 70000,
      merchant: "Amazon",
      primary: "GENERAL_MERCHANDISE",
      pending: true,
      categoryId: shopping.id,
    }),
    t7: addTx(ctx, account, { date: "2026-09-30", amount: 10000, merchant: "Corner Store" }),
    t8: addTx(ctx, account, {
      date: "2026-08-31",
      amount: 90000,
      merchant: "Amazon",
      primary: "GENERAL_MERCHANDISE",
      categoryId: shopping.id,
    }),
    t9: addTx(ctx, account, { date: "2026-10-01", amount: 5000, merchant: "Coffee" }),
  };
  return { groceries, shopping, account, ids };
}

// ---- summary --------------------------------------------------------------------------------

describe("analytics summary", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  const SEPT = "from=2026-09-01&to=2026-09-30";

  it("leaves out payments made to a credit card, however the bank labels them", async () => {
    // Plaid Sandbox labels card payments "other payment", not "credit card payment".
    const card = addAccount(ctx, { name: "Visa", type: "credit", subtype: "credit card" });
    const checking = addAccount(ctx);
    addTx(ctx, card, {
      date: "2026-09-03",
      amount: 250000,
      name: "AUTOMATIC PAYMENT - THANK",
      primary: "LOAN_PAYMENTS",
      detailed: "LOAN_PAYMENTS_OTHER_PAYMENT",
    });
    addTx(ctx, card, {
      date: "2026-09-04",
      amount: 4000,
      merchant: "Shell",
      primary: "TRANSPORTATION",
    });
    // A mortgage paid from checking is real spending and must still count.
    addTx(ctx, checking, {
      date: "2026-09-05",
      amount: 180000,
      merchant: "Home Loan Servicer",
      primary: "LOAN_PAYMENTS",
      detailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
    });
    const s = await summary(ctx, SEPT);
    expect(s.totals).toMatchObject({ spendingMinor: 184000, count: 2 });
    // Asking for transfers shows the card payment as well.
    expect((await summary(ctx, `${SEPT}&includeTransfers=1`)).totals).toMatchObject({
      spendingMinor: 434000,
      count: 3,
    });
  });

  it("defines spending and income: transfers and card payments out, refunds net, pending in", async () => {
    await scenario(ctx);
    const s = await summary(ctx, SEPT);
    // spending: groceries 100000 - 30000 refund, pending Amazon 70000, Corner Store 10000
    expect(s.totals).toEqual({
      spendingMinor: 150000,
      incomeMinor: 500000,
      netMinor: 350000,
      count: 5,
    });
  });

  it("can include transfers and card payments when asked", async () => {
    await scenario(ctx);
    const s = await summary(ctx, `${SEPT}&includeTransfers=1`);
    expect(s.totals).toMatchObject({ spendingMinor: 150000 + 200000 + 50000, count: 7 });
  });

  it("can leave out pending transactions", async () => {
    await scenario(ctx);
    const s = await summary(ctx, `${SEPT}&includePending=0`);
    expect(s.totals).toMatchObject({ spendingMinor: 80000, incomeMinor: 500000, count: 4 });
  });

  it("includes both ends of the date range and nothing outside it", async () => {
    await scenario(ctx);
    expect((await summary(ctx, "from=2026-08-31&to=2026-08-31")).totals).toMatchObject({
      spendingMinor: 90000,
      count: 1,
    });
    expect((await summary(ctx, "from=2026-09-30&to=2026-09-30")).totals).toMatchObject({
      spendingMinor: 10000,
      count: 1,
    });
    expect((await summary(ctx, "from=2026-10-01&to=2026-10-01")).totals).toMatchObject({
      spendingMinor: 5000,
      count: 1,
    });
    expect((await summary(ctx, "from=2026-09-01&to=2026-09-01")).totals).toMatchObject({
      spendingMinor: 0,
      count: 0,
    });
  });

  it("treats a category named Income, or the bank's income category, as income", async () => {
    const income = await makeCategory(ctx, "income");
    const account = addAccount(ctx);
    addTx(ctx, account, { date: "2026-09-03", amount: -40000, categoryId: income.id }); // user category
    addTx(ctx, account, { date: "2026-09-04", amount: -60000, primary: "INCOME" }); // bank category
    addTx(ctx, account, { date: "2026-09-05", amount: 1000 });
    const s = await summary(ctx, SEPT);
    expect(s.totals).toMatchObject({ incomeMinor: 100000, spendingMinor: 1000, netMinor: 99000 });
  });

  it("groups by category, with refunds netting against their category", async () => {
    await scenario(ctx);
    const s = await summary(ctx, `${SEPT}&groupBy=category`);
    expect(
      s.rows.map((r: { label: string; spendingMinor: number; incomeMinor: number }) => [
        r.label,
        r.spendingMinor,
        r.incomeMinor,
      ]),
    ).toEqual([
      ["Groceries", 70000, 0],
      ["Shopping", 70000, 0],
      ["Uncategorized", 10000, 500000],
    ]);
    expect(s.rows[0].color).toBeNull(); // categories created through the API have no color here
  });

  it("filters by category, including subcategories, and by uncategorized", async () => {
    const { shopping, ids } = await scenario(ctx);
    const gadgets = await makeCategory(ctx, "Gadgets", shopping.id);
    ctx.db
      .update(transactions)
      .set({ categoryId: gadgets.id })
      .where(eq(transactions.id, ids.t6))
      .run();
    expect((await summary(ctx, `${SEPT}&category=${shopping.id}`)).totals.spendingMinor).toBe(
      70000,
    ); // child included
    expect((await summary(ctx, `${SEPT}&category=${gadgets.id}`)).totals.spendingMinor).toBe(70000);
    expect((await summary(ctx, `${SEPT}&category=none`)).totals).toMatchObject({
      spendingMinor: 10000,
      incomeMinor: 500000,
    });
    const rolled = await summary(ctx, `${SEPT}&groupBy=category&rollupToParent=1`);
    expect(rolled.rows.find((r: { label: string }) => r.label === "Shopping").spendingMinor).toBe(
      70000,
    );
    expect(rolled.rows.some((r: { label: string }) => r.label === "Gadgets")).toBe(false);
    const flat = await summary(ctx, `${SEPT}&groupBy=category`);
    expect(flat.rows.some((r: { label: string }) => r.label === "Gadgets")).toBe(true);
  });

  it("groups by month, filling empty periods with zeros so charts have no gaps", async () => {
    await scenario(ctx);
    const s = await summary(ctx, "from=2026-07-15&to=2026-10-20&groupBy=month&fill=1");
    expect(
      s.rows.map((r: { key: string; spendingMinor: number }) => [r.key, r.spendingMinor]),
    ).toEqual([
      ["2026-07", 0],
      ["2026-08", 90000],
      ["2026-09", 150000],
      ["2026-10", 5000],
    ]);
    const sparse = await summary(ctx, "from=2026-07-15&to=2026-10-20&groupBy=month");
    expect(sparse.rows.map((r: { key: string }) => r.key)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
  });

  it("groups by week (Monday start) and by day, with fill", async () => {
    await scenario(ctx);
    const weeks = await summary(ctx, `${SEPT}&groupBy=week&fill=1`);
    expect(
      weeks.rows.map((r: { key: string; spendingMinor: number; incomeMinor: number }) => [
        r.key,
        r.spendingMinor,
        r.incomeMinor,
      ]),
    ).toEqual([
      ["2026-08-31", 70000, 0], // Sep 2 and Sep 5; the Aug 31 purchase is outside the range
      ["2026-09-07", 0, 500000],
      ["2026-09-14", 70000, 0], // Sep 20 is a Sunday: it belongs to the week starting Sep 14
      ["2026-09-21", 0, 0],
      ["2026-09-28", 10000, 0],
    ]);
    const days = await summary(ctx, "from=2026-09-01&to=2026-09-03&groupBy=day&fill=1");
    expect(
      days.rows.map((r: { key: string; spendingMinor: number }) => [r.key, r.spendingMinor]),
    ).toEqual([
      ["2026-09-01", 0],
      ["2026-09-02", 100000],
      ["2026-09-03", 0],
    ]);
  });

  it("merges merchants ignoring case and spaces, orders by spending, and folds the tail into Other", async () => {
    await scenario(ctx);
    const all = await summary(ctx, `${SEPT}&groupBy=merchant`);
    const names = all.rows.map((r: { label: string }) => r.label.toLowerCase());
    expect(names.filter((n: string) => n === "whole foods")).toHaveLength(1);
    const wf = all.rows.find((r: { label: string }) => r.label.toLowerCase() === "whole foods");
    expect(wf.spendingMinor).toBe(70000);
    const spend = all.rows.map((r: { spendingMinor: number }) => r.spendingMinor);
    expect(spend).toEqual([...spend].sort((a, b) => b - a));

    const top = await summary(ctx, `${SEPT}&groupBy=merchant&limit=2`);
    expect(top.rows).toHaveLength(3);
    expect(top.rows[2]).toMatchObject({
      key: "other",
      label: "Other",
      spendingMinor: 10000,
      incomeMinor: 500000,
    });
    expect(top.totals).toEqual(all.totals); // folding rows never changes the totals
  });

  it("sees a merchant name the user edited", async () => {
    const { ids } = await scenario(ctx);
    ctx.db
      .update(transactions)
      .set({ merchantNameUser: "Corner Shop" })
      .where(eq(transactions.id, ids.t7))
      .run();
    const s = await summary(ctx, `${SEPT}&groupBy=merchant`);
    expect(s.rows.some((r: { label: string }) => r.label === "Corner Shop")).toBe(true);
    expect(s.rows.some((r: { label: string }) => r.label === "Corner Store")).toBe(false);
  });

  it("groups by account and by institution, and filters to one account", async () => {
    const { account } = await scenario(ctx);
    const second = addAccount(ctx, { name: "Second", color: "#445566" });
    addTx(ctx, second, { date: "2026-09-09", amount: 2500, merchant: "Kiosk" });
    const byAccount = await summary(ctx, `${SEPT}&groupBy=account`);
    expect(
      byAccount.rows.map((r: { label: string; spendingMinor: number; color: string }) => [
        r.label,
        r.spendingMinor,
        r.color,
      ]),
    ).toEqual([
      ["Manual Checking", 150000, "#112233"],
      ["Second", 2500, "#445566"],
    ]);
    expect((await summary(ctx, `${SEPT}&groupBy=institution`)).rows).toHaveLength(1);
    expect((await summary(ctx, `${SEPT}&groupBy=institution`)).rows[0].label).toBe(
      "Manual accounts",
    );
    expect((await summary(ctx, `${SEPT}&accountId=${account}`)).totals.spendingMinor).toBe(150000);
    expect((await summary(ctx, `${SEPT}&accountId=${second}`)).totals.spendingMinor).toBe(2500);
  });

  it("totals always equal the sum of the rows, whatever the grouping", async () => {
    await scenario(ctx);
    for (const groupBy of [
      "none",
      "day",
      "week",
      "month",
      "category",
      "merchant",
      "account",
      "institution",
    ]) {
      const s = await summary(ctx, `from=2026-08-01&to=2026-10-31&groupBy=${groupBy}`);
      const sum = (key: string) =>
        s.rows.reduce((n: number, r: Record<string, number>) => n + (r[key] ?? 0), 0);
      expect({ groupBy, spending: sum("spendingMinor") }).toEqual({
        groupBy,
        spending: s.totals.spendingMinor,
      });
      expect({ groupBy, income: sum("incomeMinor") }).toEqual({
        groupBy,
        income: s.totals.incomeMinor,
      });
      expect({ groupBy, net: sum("netMinor") }).toEqual({ groupBy, net: s.totals.netMinor });
      expect({ groupBy, count: sum("count") }).toEqual({ groupBy, count: s.totals.count });
    }
  });

  it("returns zeros, not errors, when there is nothing", async () => {
    const s = await summary(ctx, `${SEPT}&groupBy=month&fill=1`);
    expect(s.rows).toEqual([
      {
        key: "2026-09",
        label: "2026-09",
        color: null,
        spendingMinor: 0,
        incomeMinor: 0,
        netMinor: 0,
        count: 0,
      },
    ]);
    expect(s.totals).toEqual({ spendingMinor: 0, incomeMinor: 0, netMinor: 0, count: 0 });
    expect((await summary(ctx, `${SEPT}&groupBy=category`)).rows).toEqual([]);
  });

  it("rejects bad queries", async () => {
    for (const q of [
      "to=2026-09-30",
      "from=2026-09-01",
      "from=2026-09-30&to=2026-09-01",
      "from=2026-02-30&to=2026-03-01",
      "from=yesterday&to=today",
      `${SEPT}&groupBy=planet`,
      `${SEPT}&limit=0`,
      `${SEPT}&limit=101`,
      `${SEPT}&category=abc`,
      `${SEPT}&accountId=-1`,
      `${SEPT}&includePending=maybe`,
      "from=2000-01-01&to=2026-12-31&groupBy=day",
    ]) {
      await summary(ctx, q, 400);
    }
  });

  it("does not mix in transactions of another data source", async () => {
    const h = makeSyncHarness();
    try {
      const { item } = await linkDemoBank(h.call);
      await h.sync.syncItem(item.id, "manual");
      const range = "from=2026-06-01&to=2026-09-30";
      const demo = (await h.call("get", `/api/analytics/summary?${range}`).expect(200)).body;
      expect(demo.totals.count).toBeGreaterThan(50);
      await h.call("patch", "/api/settings").send({ plaidEnvironment: "sandbox" }).expect(200);
      expect(
        (await h.call("get", `/api/analytics/summary?${range}`).expect(200)).body.totals.count,
      ).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("analytics summary on synced demo data", () => {
  it("agrees with an independent calculation from the stored transactions", async () => {
    const h = makeSyncHarness();
    try {
      seedDefaults(h.db);
      const { item } = await linkDemoBank(h.call);
      await h.sync.syncItem(item.id, "manual");

      const rows = h.db.select().from(transactions).all();
      const isTransfer = (t: (typeof rows)[number]) =>
        t.isTransfer || t.plaidCategoryDetailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";
      const inMonth = rows.filter(
        (t) => t.date >= "2026-08-01" && t.date <= "2026-08-31" && !isTransfer(t),
      );
      const income = inMonth.filter((t) => t.plaidCategoryPrimary === "INCOME");
      const expectedIncome = -income.reduce((n, t) => n + t.amountMinor, 0);
      const expectedSpending = inMonth
        .filter((t) => t.plaidCategoryPrimary !== "INCOME")
        .reduce((n, t) => n + t.amountMinor, 0);

      const s = (
        await h.call("get", "/api/analytics/summary?from=2026-08-01&to=2026-08-31").expect(200)
      ).body;
      expect(s.totals).toMatchObject({
        spendingMinor: expectedSpending,
        incomeMinor: expectedIncome,
        count: inMonth.length,
      });
      expect(expectedSpending).toBeGreaterThan(0);
      expect(expectedIncome).toBeGreaterThan(0);

      // The calendar and the transaction list agree with each other, day by day.
      const cal = (await h.call("get", "/api/analytics/calendar?month=2026-08").expect(200)).body;
      for (const day of cal.days.slice(0, 6)) {
        const list = (
          await h
            .call("get", `/api/transactions?from=${day.date}&to=${day.date}&pageSize=200`)
            .expect(200)
        ).body;
        expect(list.total).toBe(day.count);
      }
    } finally {
      h.cleanup();
    }
  });
});

// ---- calendar -------------------------------------------------------------------------------

describe("calendar", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("shows each day with its accounts, money in and out, and pending items", async () => {
    const { account } = await scenario(ctx);
    const second = addAccount(ctx, { name: "Second", color: "#445566" });
    addTx(ctx, second, { date: "2026-09-02", amount: 2500 });
    const cal = (await ctx.call("get", "/api/analytics/calendar?month=2026-09").expect(200)).body;
    expect(cal.month).toBe("2026-09");
    const second2 = cal.days.find((d: { date: string }) => d.date === "2026-09-02");
    expect(second2).toMatchObject({
      count: 2,
      pendingCount: 0,
      outflowMinor: 102500,
      inflowMinor: 0,
    });
    expect(second2.accounts).toEqual([
      {
        accountId: account,
        name: "Manual Checking",
        color: "#112233",
        count: 1,
        outflowMinor: 100000,
        inflowMinor: 0,
      },
      {
        accountId: second,
        name: "Second",
        color: "#445566",
        count: 1,
        outflowMinor: 2500,
        inflowMinor: 0,
      },
    ]);
    expect(cal.days.find((d: { date: string }) => d.date === "2026-09-20")).toMatchObject({
      count: 1,
      pendingCount: 1,
      outflowMinor: 70000,
    });
    expect(cal.days.find((d: { date: string }) => d.date === "2026-09-10")).toMatchObject({
      inflowMinor: 500000,
      outflowMinor: 0,
    });
    expect(cal.days.find((d: { date: string }) => d.date === "2026-09-05")).toMatchObject({
      inflowMinor: 30000,
    });
  });

  it("includes transfers, keeps to the month, leaves empty days out, and can filter by account", async () => {
    const { account } = await scenario(ctx);
    const cal = (await ctx.call("get", "/api/analytics/calendar?month=2026-09").expect(200)).body;
    const dates = cal.days.map((d: { date: string }) => d.date);
    expect(dates).toContain("2026-09-12"); // the Zelle transfer
    expect(dates).not.toContain("2026-08-31");
    expect(dates).not.toContain("2026-10-01");
    expect(dates).toEqual([...dates].sort());
    const other = addAccount(ctx, { name: "Other" });
    expect(
      (
        await ctx
          .call("get", `/api/analytics/calendar?month=2026-09&accountId=${other}`)
          .expect(200)
      ).body.days,
    ).toEqual([]);
    expect(
      (
        await ctx
          .call("get", `/api/analytics/calendar?month=2026-09&accountId=${account}`)
          .expect(200)
      ).body.days.length,
    ).toBe(dates.length);
    expect(
      (await ctx.call("get", "/api/analytics/calendar?month=2027-01").expect(200)).body.days,
    ).toEqual([]);
  });

  it("rejects a bad month", async () => {
    for (const month of ["2026-13", "2026-9", "september", "", "2026-00"]) {
      await ctx.call("get", `/api/analytics/calendar?month=${month}`).expect(400);
    }
    await ctx.call("get", "/api/analytics/calendar").expect(400);
  });
});

// ---- overview -------------------------------------------------------------------------------

describe("overview", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  it("is all zeros with no accounts", async () => {
    const o = (await ctx.call("get", "/api/analytics/overview").expect(200)).body;
    expect(o).toMatchObject({
      currency: "USD",
      assetsMinor: 0,
      liabilitiesMinor: 0,
      netWorthMinor: 0,
      creditCards: [],
    });
    expect(o.coverage).toMatchObject({
      accountsCounted: 0,
      accountsWithoutBalance: 0,
      accountsOtherCurrency: 0,
      oldestBalanceAt: null,
    });
  });

  it("adds up assets and debts, flags what it could not count, and describes each card", async () => {
    addAccount(ctx, {
      name: "Checking",
      currentBalanceMinor: 100000,
      lastBalanceUpdateAt: "2026-09-01T10:00:00Z",
    });
    addAccount(ctx, {
      name: "Savings",
      subtype: "savings",
      currentBalanceMinor: 50000,
      lastBalanceUpdateAt: "2026-09-03T10:00:00Z",
    });
    addAccount(ctx, {
      name: "Brokerage",
      type: "investment",
      subtype: "brokerage",
      currentBalanceMinor: 300000,
    });
    addAccount(ctx, {
      name: "Car loan",
      type: "loan",
      subtype: "auto",
      currentBalanceMinor: 10000,
    });
    const card = addAccount(ctx, {
      name: "Card",
      type: "credit",
      subtype: "credit card",
      currentBalanceMinor: 20000,
      color: "#dc2626",
    });
    addAccount(ctx, { name: "No balance yet", currentBalanceMinor: null });
    addAccount(ctx, { name: "Euro account", currency: "EUR", currentBalanceMinor: 9999 });
    for (const [limit, date, source] of [
      [100000, "2026-01-01", "manual"],
      [150000, "2026-05-01", "plaid"],
    ] as const) {
      ctx.db
        .insert(creditLimitHistory)
        .values({
          accountId: card,
          limitMinor: limit,
          currency: "USD",
          effectiveDate: date,
          source,
          createdAt: "x",
          updatedAt: "x",
        })
        .run();
    }

    const o = (await ctx.call("get", "/api/analytics/overview").expect(200)).body;
    expect(o).toMatchObject({
      cashMinor: 150000,
      investmentsMinor: 300000,
      assetsMinor: 450000,
      creditDebtMinor: 20000,
      loanDebtMinor: 10000,
      liabilitiesMinor: 30000,
      netWorthMinor: 420000,
    });
    expect(o.coverage).toEqual({
      accountsCounted: 5,
      accountsWithoutBalance: 1,
      accountsOtherCurrency: 1,
      oldestBalanceAt: "2026-09-01T10:00:00Z",
      newestBalanceAt: "2026-09-03T10:00:00Z",
    });
    expect(o.creditCards).toEqual([
      {
        accountId: card,
        name: "Card",
        color: "#dc2626",
        institutionName: null,
        balanceMinor: 20000,
        limitMinor: 150000,
        utilizationPercent: 13,
        lastLimitChange: {
          effectiveDate: "2026-05-01",
          changeMinor: 50000,
          changePercent: 50,
          source: "plaid",
        },
      },
    ]);
  });

  it("reports a card with no known limit without inventing a utilization", async () => {
    addAccount(ctx, {
      name: "Card",
      type: "credit",
      subtype: "credit card",
      currentBalanceMinor: 20000,
    });
    const card = (await ctx.call("get", "/api/analytics/overview").expect(200)).body.creditCards[0];
    expect(card).toMatchObject({
      limitMinor: null,
      utilizationPercent: null,
      lastLimitChange: null,
    });
  });

  it("only counts the data source in use", async () => {
    const h = makeSyncHarness();
    try {
      const { item } = await linkDemoBank(h.call);
      await h.sync.syncItem(item.id, "manual");
      expect(
        (await h.call("get", "/api/analytics/overview").expect(200)).body.coverage.accountsCounted,
      ).toBe(3);
      await h.call("patch", "/api/settings").send({ plaidEnvironment: "sandbox" }).expect(200);
      expect(
        (await h.call("get", "/api/analytics/overview").expect(200)).body.coverage.accountsCounted,
      ).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

// ---- budgets --------------------------------------------------------------------------------

describe("budgets", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  const month = async (m: string) =>
    (await ctx.call("get", `/api/budgets?month=${m}`).expect(200)).body;
  const create = (categoryId: number, m: string, amountMinor: number, expected = 201) =>
    ctx.call("post", "/api/budgets").send({ categoryId, month: m, amountMinor }).expect(expected);

  it("shows spending against each budget, only within its month", async () => {
    const { groceries, shopping } = await scenario(ctx);
    await create(groceries.id, "2026-09", 100000);
    await create(shopping.id, "2026-09", 50000);
    const b = await month("2026-09");
    expect(
      b.budgets.map((x: Record<string, unknown>) => [
        x.categoryName,
        x.amountMinor,
        x.spentMinor,
        x.remainingMinor,
        x.percentUsed,
        x.overspent,
      ]),
    ).toEqual([
      ["Groceries", 100000, 70000, 30000, 70, false],
      ["Shopping", 50000, 70000, -20000, 140, true], // pending counts; the Aug 31 purchase does not
    ]);
    expect(b.totals).toEqual({ budgetedMinor: 150000, spentMinor: 140000, remainingMinor: 10000 });
    expect(b.unbudgetedSpendingMinor).toBe(10000); // Corner Store
    // The same category in the month before sees its own spending.
    await create(shopping.id, "2026-08", 50000);
    expect((await month("2026-08")).budgets[0]).toMatchObject({
      spentMinor: 90000,
      overspent: true,
    });
  });

  it("counts subcategory spending toward the parent's budget", async () => {
    const { shopping, ids } = await scenario(ctx);
    const gadgets = await makeCategory(ctx, "Gadgets", shopping.id);
    ctx.db
      .update(transactions)
      .set({ categoryId: gadgets.id })
      .where(eq(transactions.id, ids.t6))
      .run();
    await create(shopping.id, "2026-09", 100000);
    await create(gadgets.id, "2026-09", 30000);
    const b = await month("2026-09");
    expect(
      b.budgets.find((x: { categoryName: string }) => x.categoryName === "Shopping").spentMinor,
    ).toBe(70000);
    expect(
      b.budgets.find((x: { categoryName: string }) => x.categoryName === "Gadgets").spentMinor,
    ).toBe(70000);
    // Groceries (70000) and Corner Store (10000) have no budget; shopping and gadgets are covered.
    expect(b.unbudgetedSpendingMinor).toBe(80000);
  });

  it("allows one budget per category per month", async () => {
    const c = await makeCategory(ctx, "Fun");
    await create(c.id, "2026-09", 1000);
    expect((await create(c.id, "2026-09", 2000, 409)).body.error).toBe("duplicate_budget");
    await create(c.id, "2026-10", 2000);
  });

  it("rejects bad budgets", async () => {
    const c = await makeCategory(ctx, "Fun");
    const archived = await makeCategory(ctx, "Old");
    await ctx.call("patch", `/api/categories/${archived.id}`).send({ active: false }).expect(200);
    for (const [body, status] of [
      [{ categoryId: c.id, month: "2026-09", amountMinor: 0 }, 400],
      [{ categoryId: c.id, month: "2026-09", amountMinor: -5 }, 400],
      [{ categoryId: c.id, month: "2026-09", amountMinor: 1.5 }, 400],
      [{ categoryId: c.id, month: "2026-13", amountMinor: 100 }, 400],
      [{ categoryId: c.id, month: "Sept", amountMinor: 100 }, 400],
      [{ categoryId: 9999, month: "2026-09", amountMinor: 100 }, 400],
      [{ categoryId: archived.id, month: "2026-09", amountMinor: 100 }, 400],
      [{ categoryId: c.id, month: "2026-09" }, 400],
      [{ categoryId: c.id, month: "2026-09", amountMinor: 100, extra: 1 }, 400],
    ] as const) {
      await ctx.call("post", "/api/budgets").send(body).expect(status);
    }
    await ctx.call("get", "/api/budgets").expect(400);
    await ctx.call("get", "/api/budgets?month=2026-99").expect(400);
  });

  it("updates, deletes, and hides budgets of archived categories", async () => {
    const c = await makeCategory(ctx, "Fun");
    const id = (await create(c.id, "2026-09", 1000)).body.id;
    expect(
      (await ctx.call("patch", `/api/budgets/${id}`).send({ amountMinor: 5000 }).expect(200)).body,
    ).toMatchObject({ amountMinor: 5000 });
    await ctx.call("patch", `/api/budgets/${id}`).send({ amountMinor: 0 }).expect(400);
    await ctx.call("patch", "/api/budgets/9999").send({ amountMinor: 5 }).expect(404);
    await ctx.call("patch", `/api/categories/${c.id}`).send({ active: false }).expect(200);
    expect((await month("2026-09")).budgets).toEqual([]);
    await ctx.call("patch", `/api/categories/${c.id}`).send({ active: true }).expect(200);
    expect((await month("2026-09")).budgets).toHaveLength(1);
    await ctx.call("delete", `/api/budgets/${id}`).expect(204);
    await ctx.call("delete", `/api/budgets/${id}`).expect(404);
  });

  it("copies one month's budgets to another without overwriting", async () => {
    const a = await makeCategory(ctx, "A");
    const b = await makeCategory(ctx, "B");
    const gone = await makeCategory(ctx, "Gone");
    await create(a.id, "2026-08", 1000);
    await create(b.id, "2026-08", 2000);
    await create(gone.id, "2026-08", 3000);
    await create(b.id, "2026-09", 9999); // already has one: must not be overwritten
    await ctx.call("patch", `/api/categories/${gone.id}`).send({ active: false }).expect(200);
    const res = (
      await ctx
        .call("post", "/api/budgets/copy")
        .send({ fromMonth: "2026-08", toMonth: "2026-09" })
        .expect(200)
    ).body;
    expect(res).toEqual({ created: 1, skipped: 2 });
    const sept = (await month("2026-09")).budgets.map(
      (x: { categoryName: string; amountMinor: number }) => [x.categoryName, x.amountMinor],
    );
    expect(sept).toEqual([
      ["A", 1000],
      ["B", 9999],
    ]);
    await ctx
      .call("post", "/api/budgets/copy")
      .send({ fromMonth: "2026-08", toMonth: "2026-08" })
      .expect(400);
    await ctx
      .call("post", "/api/budgets/copy")
      .send({ fromMonth: "bad", toMonth: "2026-08" })
      .expect(400);
  });

  it("keeps a category that has budgets (archives it) and merges budgets when reassigning", async () => {
    const a = await makeCategory(ctx, "A");
    const b = await makeCategory(ctx, "B");
    await create(a.id, "2026-09", 1000);
    await create(a.id, "2026-10", 2000);
    await create(b.id, "2026-09", 5000);
    // Deleting a category with budgets archives it instead.
    const c = await makeCategory(ctx, "C");
    await create(c.id, "2026-09", 700);
    expect((await ctx.call("delete", `/api/categories/${c.id}`).expect(200)).body.outcome).toBe(
      "archived",
    );
    // Reassigning moves budgets, and the target's own budget wins where both exist.
    await ctx.call("delete", `/api/categories/${a.id}?reassignTo=${b.id}`).expect(200);
    const rows = ctx.db
      .select()
      .from(budgets)
      .all()
      .filter((r) => r.categoryId === b.id);
    expect(rows.map((r) => [r.periodStart, r.amountMinor]).sort()).toEqual([
      ["2026-09-01", 5000],
      ["2026-10-01", 2000],
    ]);
  });
});

// ---- dashboard layout -----------------------------------------------------------------------

describe("dashboard layout", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.cleanup());

  const widget = (over: Record<string, unknown> = {}) => ({
    widgetType: "spending-by-category",
    enabled: true,
    x: 0,
    y: 0,
    w: 4,
    h: 4,
    config: {},
    ...over,
  });
  const get = async () => (await ctx.call("get", "/api/dashboard/widgets").expect(200)).body;
  const put = (widgets: unknown[], expected = 200) =>
    ctx.call("put", "/api/dashboard/widgets").send({ widgets }).expect(expected);

  it("starts uninitialized and empty, so the app can build its default layout", async () => {
    expect(await get()).toEqual({ dashboardId: 1, initialized: false, widgets: [] });
  });

  it("saves a layout, hands back IDs, and marks it set up", async () => {
    const res = (
      await put([
        widget({ config: { period: "month", nested: { a: [1, 2, { b: true }] } } }),
        widget({ widgetType: "calendar", x: 4, w: 8 }),
      ])
    ).body;
    expect(res.initialized).toBe(true);
    expect(res.widgets).toHaveLength(2);
    expect(res.widgets.every((w: { id: number }) => Number.isInteger(w.id))).toBe(true);
    expect(res.widgets[0].config).toEqual({ period: "month", nested: { a: [1, 2, { b: true }] } });
    expect(await get()).toEqual(res);
  });

  it("updates widgets that have IDs, adds new ones, and removes those left out", async () => {
    const first = (
      await put([
        widget(),
        widget({ widgetType: "calendar", x: 4 }),
        widget({ widgetType: "net-worth", x: 8 }),
      ])
    ).body.widgets;
    const [a, b] = first;
    const next = (
      await put([
        { ...a, x: 6, w: 6, config: { top: 3 }, enabled: false },
        widget({ widgetType: "recent-transactions", y: 4 }),
      ])
    ).body.widgets;
    expect(next).toHaveLength(2);
    const kept = next.find((w: { id: number }) => w.id === a.id);
    expect(kept).toMatchObject({
      x: 6,
      w: 6,
      enabled: false,
      config: { top: 3 },
      widgetType: "spending-by-category",
    });
    expect(next.some((w: { id: number }) => w.id === b.id)).toBe(false);
    expect(
      next.find((w: { widgetType: string }) => w.widgetType === "recent-transactions").id,
    ).not.toBe(a.id);
    expect(ctx.db.select().from(dashboardWidgets).all()).toHaveLength(2);
  });

  it("treats unknown IDs as new widgets and never duplicates a repeated ID", async () => {
    const saved = (await put([widget()])).body.widgets[0];
    const res = (
      await put([{ ...saved }, { ...saved, x: 4 }, widget({ id: 9999, widgetType: "calendar" })])
    ).body.widgets;
    expect(res).toHaveLength(3);
    expect(new Set(res.map((w: { id: number }) => w.id)).size).toBe(3);
  });

  it("keeps widget types this version does not know, untouched", async () => {
    await put([widget({ widgetType: "removed-in-a-later-version", config: { keep: "me" } })]);
    expect((await get()).widgets[0]).toMatchObject({
      widgetType: "removed-in-a-later-version",
      config: { keep: "me" },
    });
  });

  it("stays empty when the user clears the dashboard, and rebuilds only after a reset", async () => {
    await put([widget()]);
    const cleared = (await put([])).body;
    expect(cleared).toEqual({ dashboardId: 1, initialized: true, widgets: [] });
    expect(await get()).toEqual({ dashboardId: 1, initialized: true, widgets: [] });
    await put([widget()]);
    const reset = (await ctx.call("post", "/api/dashboard/reset").expect(200)).body;
    expect(reset).toEqual({ dashboardId: 1, initialized: false, widgets: [] });
  });

  it("returns an empty settings object if a stored one is damaged", async () => {
    const saved = (await put([widget({ config: { a: 1 } })])).body.widgets[0];
    ctx.db
      .update(dashboardWidgets)
      .set({ config: "{not json" })
      .where(eq(dashboardWidgets.id, saved.id))
      .run();
    expect((await get()).widgets[0].config).toEqual({});
    ctx.db
      .update(dashboardWidgets)
      .set({ config: "[1,2]" })
      .where(eq(dashboardWidgets.id, saved.id))
      .run();
    expect((await get()).widgets[0].config).toEqual({});
  });

  it("rejects bad layouts, and a rejected save changes nothing", async () => {
    const before = (await put([widget(), widget({ widgetType: "calendar", x: 4 })])).body;
    const tooBig = { a: "x".repeat(20_001) };
    for (const bad of [
      [widget(), widget({ widgetType: "has space" })],
      [widget({ widgetType: "" })],
      [widget({ widgetType: "x".repeat(65) })],
      [widget({ widgetType: "semi;colon" })],
      [widget({ x: -1 })],
      [widget({ y: 1.5 })],
      [widget({ w: 0 })],
      [widget({ h: 0 })],
      [widget({ w: 49 })],
      [widget({ config: "text" })],
      [widget({ config: [1] })],
      [widget({ config: tooBig })],
      [widget({ enabled: "yes" })],
      [{ widgetType: "calendar", enabled: true, x: 0, y: 0, w: 4 }],
      [widget({ extra: 1 })],
      Array.from({ length: 101 }, () => widget()),
    ]) {
      await put(bad, 400);
    }
    await ctx.call("put", "/api/dashboard/widgets").send({}).expect(400);
    await ctx.call("put", "/api/dashboard/widgets").send({ widgets: [], extra: 1 }).expect(400);
    expect(await get()).toEqual(before);
  });

  it("accepts a full dashboard of 100 widgets", async () => {
    const res = (await put(Array.from({ length: 100 }, (_, i) => widget({ y: i })))).body;
    expect(res.widgets).toHaveLength(100);
  });

  it("requires the API token on every new endpoint", async () => {
    const { default: request } = await import("supertest");
    const host = "127.0.0.1:47998";
    for (const [method, url] of [
      ["get", "/api/dashboard/widgets"],
      ["put", "/api/dashboard/widgets"],
      ["post", "/api/dashboard/reset"],
      ["get", "/api/analytics/summary?from=2026-01-01&to=2026-01-02"],
      ["get", "/api/analytics/calendar?month=2026-01"],
      ["get", "/api/analytics/overview"],
      ["get", "/api/budgets?month=2026-01"],
      ["post", "/api/budgets"],
      ["post", "/api/budgets/copy"],
    ] as const) {
      await request(ctx.app)[method](url).set("Host", host).expect(401);
    }
  });
});
