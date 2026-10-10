import { afterEach, describe, expect, it } from "vitest";
import { closingDates, dueAfter, listBills } from "./services/bills.service.js";
import { cashForecast } from "./services/forecast.service.js";
import { reviewQueue } from "./services/review.service.js";
import { setSubscriptionReview, subscriptionReview } from "./services/subscriptions.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = async (name: string, kind: string) =>
    (await t.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
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
  return { t, account, add };
}

/** A card whose statement closed Sep 25 (due Oct 20), and a checking account that paid part of it. */
async function wallet() {
  const s = await setup();
  const card = await s.account("Visa", "credit_card");
  const checking = await s.account("Checking", "checking");
  await s.add(checking, "2026-09-01", "Paycheck", 100_000, "in");
  await s.add(card, "2026-09-20", "Groceries Store", 30_000);
  await s.add(card, "2026-10-01", "Hardware Store", 5_000);
  await s.add(card, "2026-10-05", "PAYMENT - THANK YOU", 10_000, "in");
  await s.add(checking, "2026-10-05", "ONLINE PMT VISA", 10_000);
  await s.t
    .call("put", `/api/accounts/${card}/bill`)
    .send({ closingDay: 25, dueDay: 20, minimumMinor: 3500 })
    .expect(200);
  return { ...s, card, checking };
}

describe("card bills", () => {
  it("works out statement dates, also in short months", () => {
    expect(closingDates(25, "2026-10-09")).toEqual({ last: "2026-09-25", next: "2026-10-25" });
    expect(closingDates(31, "2026-03-05")).toEqual({ last: "2026-02-28", next: "2026-03-31" });
    expect(dueAfter("2026-09-25", 20)).toBe("2026-10-20");
    expect(dueAfter("2026-09-05", 30)).toBe("2026-09-30");
  });

  it("works out the latest statement, what was paid toward it, and what is charged since", async () => {
    const { t, card } = await wallet();
    const bill = listBills(t.db, TODAY).find((b) => b.accountId === card)!;
    expect(bill.statement).toMatchObject({
      closedOn: "2026-09-25",
      dueOn: "2026-10-20",
      balanceMinor: 30_000,
      paidMinor: 10_000,
      remainingMinor: 20_000,
      minimumMinor: 3500,
      status: "partial",
      daysUntilDue: 11,
    });
    expect(bill.next).toEqual({
      closesOn: "2026-10-25",
      dueOn: "2026-11-20",
      balanceSoFarMinor: 5_000,
    });
    expect(listBills(t.db, "2026-10-21").find((b) => b.accountId === card)!.statement!.status).toBe(
      "overdue",
    );
  });

  it("lists a card without dates as not set up, and refuses bad days or non-cards", async () => {
    const { t, account } = await setup();
    const card = await account("Plain", "credit_card");
    const checking = await account("Checking", "checking");
    const bills = (await t.call("get", "/api/bills").expect(200)).body;
    expect(bills).toEqual([
      expect.objectContaining({ accountId: card, settings: null, statement: null }),
    ]);
    await t
      .call("put", `/api/accounts/${card}/bill`)
      .send({ closingDay: 0, dueDay: 5 })
      .expect(400);
    await t
      .call("put", `/api/accounts/${checking}/bill`)
      .send({ closingDay: 5, dueDay: 25 })
      .expect(409);
  });
});

describe("cash-flow forecast", () => {
  it("starts from the bank balances and takes off card bills on their due days", async () => {
    const { t } = await wallet();
    const f = cashForecast(t.db, { today: TODAY, days: 60 });
    expect(f.startBalanceMinor).toBe(90_000);
    expect(f.accountsCounted).toBe(1);
    const on = (date: string) => f.days.find((d) => d.date === date)!;
    expect(on("2026-10-20")).toMatchObject({ changeMinor: -20_000, balanceMinor: 70_000 });
    expect(on("2026-10-20").events[0]).toMatchObject({ source: "card_bill" });
    expect(on("2026-11-20")).toMatchObject({ changeMinor: -5_000, balanceMinor: 65_000 });
    expect(f.lowest).toEqual({ date: "2026-11-20", balanceMinor: 65_000 });
    expect(f.days).toHaveLength(61);
  });

  it("continues recurring money in and out of the bank on its schedule", async () => {
    const { t, account, add } = await setup();
    const checking = await account("Checking", "checking");
    for (const month of ["06", "07", "08", "09"]) {
      await add(checking, `2026-${month}-01`, "ACME PAYROLL", 300_000, "in");
      await add(checking, `2026-${month}-03`, "City Apartments", 150_000);
    }
    const f = cashForecast(t.db, { today: TODAY, days: 60 });
    const sources = f.days.flatMap((d) => d.events.map((e) => [d.date, e.label, e.amountMinor]));
    expect(sources).toContainEqual(["2026-11-01", "ACME PAYROLL", 300_000]);
    expect(sources).toContainEqual(["2026-11-03", "City Apartments", -150_000]);
  });
});

describe("subscription review", () => {
  it("lists recurring charges with their yearly cost, and keeps the user's decision", async () => {
    const { t, account, add } = await setup();
    const card = await account("Visa", "credit_card");
    for (const month of ["06", "07", "08", "09"])
      await add(card, `2026-${month}-15`, "Netflix", 1599);
    const review = subscriptionReview(t.db, { today: TODAY });
    const netflix = review.subscriptions.find((s) => s.merchant === "Netflix")!;
    expect(netflix).toMatchObject({ cadence: "monthly", yearlyMinor: 1599 * 12, review: null });
    setSubscriptionReview(t.db, netflix.key, {
      merchant: "Netflix",
      status: "cancel",
      note: "too many",
    });
    const after = subscriptionReview(t.db, { today: TODAY });
    expect(after.subscriptions.find((s) => s.key === netflix.key)!.review).toEqual({
      status: "cancel",
      note: "too many",
    });
    expect(after.totals.toCancelYearlyMinor).toBe(1599 * 12);
    await t
      .call("put", `/api/subscriptions/${encodeURIComponent(netflix.key)}`)
      .send({ merchant: "Netflix", status: "nope" })
      .expect(400);
  });
});

describe("the month-end report", () => {
  it("sums the month and compares it with the one before", async () => {
    const { t, account, add } = await setup();
    const checking = await account("Checking", "checking");
    await add(checking, "2026-08-02", "Store", 20_000);
    const pay = await add(checking, "2026-09-01", "Paycheck", 100_000, "in");
    // As the bank labels a paycheck.
    t.sqlite
      .prepare("UPDATE transactions SET plaid_category_primary = 'INCOME' WHERE id = ?")
      .run(pay);
    await add(checking, "2026-09-05", "Store", 30_000);
    await add(checking, "2026-09-06", "Big TV", 80_000);
    const r = (await t.call("get", "/api/reports/month?month=2026-09").expect(200)).body;
    expect(r).toMatchObject({
      month: "2026-09",
      incomeMinor: 100_000,
      spendingMinor: 110_000,
      savedMinor: -10_000,
      savingsRatePercent: -10,
      previous: { spendingMinor: 20_000, incomeMinor: 0 },
    });
    expect(r.largest[0]).toMatchObject({ merchant: "Big TV", amountMinor: 80_000 });
    await t.call("get", "/api/reports/month?month=2026-13").expect(400);
  });
});

describe("attachments", () => {
  it("stores a file on a transaction, gives it back, and deletes it", async () => {
    const { t, account, add } = await setup();
    const checking = await account("Checking", "checking");
    const tx = await add(checking, "2026-09-05", "Store", 3000);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const created = (
      await t
        .call("post", `/api/transactions/${tx}/attachments?name=receipt.png`)
        .set("content-type", "image/png")
        .send(png)
        .expect(201)
    ).body;
    expect(created).toMatchObject({
      transactionId: tx,
      name: "receipt.png",
      mime: "image/png",
      size: 8,
    });
    expect(
      (await t.call("get", `/api/transactions/${tx}/attachments`).expect(200)).body,
    ).toHaveLength(1);
    const file = await t.call("get", `/api/attachments/${created.id}`).buffer(true).expect(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(file.body as Buffer, png)).toBe(0);
    await t.call("delete", `/api/attachments/${created.id}`).expect(204);
    await t.call("get", `/api/attachments/${created.id}`).expect(404);
  });

  it("refuses files that are not pictures, PDFs, or text, and empty ones", async () => {
    const { t, account, add } = await setup();
    const tx = await add(await account("Checking", "checking"), "2026-09-05", "Store", 3000);
    await t
      .call("post", `/api/transactions/${tx}/attachments?name=x.html`)
      .set("content-type", "text/html")
      .send(Buffer.from("<script>"))
      .expect(415);
    await t
      .call("post", `/api/transactions/9999/attachments?name=a.png`)
      .set("content-type", "image/png")
      .send(Buffer.from([1]))
      .expect(404);
  });
});

describe("duplicates and the review queue", () => {
  it("finds a transaction entered twice, and forgets it once dismissed", async () => {
    const { t, account, add } = await setup();
    const card = await account("Visa", "credit_card");
    const a = await add(card, "2026-10-01", "Coffee Shop", 450);
    const b = await add(card, "2026-10-02", "COFFEE SHOP #12", 450);
    // As if the second came from the bank.
    t.sqlite.prepare("UPDATE transactions SET source = 'plaid' WHERE id = ?").run(b);
    const dupes = (await t.call("get", "/api/duplicates").expect(200)).body;
    expect(dupes).toHaveLength(1);
    expect(dupes[0].transactions.map((x: { id: number }) => x.id)).toEqual([a, b]);
    await t.call("post", "/api/duplicates/dismiss").send({ a: b, b: a }).expect(204);
    expect((await t.call("get", "/api/duplicates").expect(200)).body).toEqual([]);
  });

  it("flags new merchants, unusual and large amounts, and no category, until marked reviewed", async () => {
    const { t, account, add } = await setup();
    const card = await account("Visa", "credit_card");
    for (const d of ["2026-06-01", "2026-07-01", "2026-08-01"]) await add(card, d, "Cafe", 500);
    const unusual = await add(card, "2026-09-20", "Cafe", 5_000);
    const big = await add(card, "2026-09-21", "Laptop World", 120_000);
    const q = reviewQueue(t.db, TODAY);
    const reasons = (id: number) => q.items.find((i) => i.transaction.id === id)?.reasons;
    expect(reasons(unusual)).toEqual(expect.arrayContaining(["unusual_amount", "uncategorized"]));
    expect(reasons(big)).toEqual(expect.arrayContaining(["new_merchant", "large"]));
    // Older than the window: not in the queue.
    expect(q.items.some((i) => i.transaction.date === "2026-06-01")).toBe(false);
    await t
      .call("post", "/api/review/mark")
      .send({ ids: [unusual, big] })
      .expect(200);
    const after = (await t.call("get", "/api/review").expect(200)).body;
    expect(after.items.map((i: { transaction: { id: number } }) => i.transaction.id)).not.toContain(
      big,
    );
  });
});
