import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { accounts, cardBills } from "../../drizzle/schema.js";
import { combinedStatements, statementPeriods, statements } from "./services/statement.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("statement periods", () => {
  it("run from the day after one closing date through the next, newest first", () => {
    expect(statementPeriods(15, 10, "2026-10-20", 3)).toEqual([
      { start: "2026-10-16", end: "2026-11-15", due: "2026-12-10", current: true },
      { start: "2026-09-16", end: "2026-10-15", due: "2026-11-10", current: false },
      { start: "2026-08-16", end: "2026-09-15", due: "2026-10-10", current: false },
    ]);
  });

  it("close on the month's last day when it is shorter, and fall due after closing", () => {
    expect(statementPeriods(31, 25, "2026-02-10", 2)).toEqual([
      { start: "2026-02-01", end: "2026-02-28", due: "2026-03-25", current: true },
      { start: "2026-01-01", end: "2026-01-31", due: "2026-02-25", current: false },
    ]);
    // Closing today: today is the open period's last day.
    expect(statementPeriods(12, null, "2026-10-12", 1)[0]).toMatchObject({
      start: "2026-09-13",
      end: "2026-10-12",
      due: null,
    });
  });
});

describe("a card's statements", () => {
  it("show charges, payments, credits and spending by category for each period", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const card = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Visa", kind: "credit_card" })
        .expect(201)
    ).body.id as number;
    const food = (await t.call("post", "/api/categories").send({ name: "Food" }).expect(201)).body
      .id as number;
    const add = (body: Record<string, unknown>) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId: card, ...body })
        .expect(201);
    await add({
      date: "2026-09-10",
      merchant: "Grocer",
      amountMinor: 3000,
      direction: "out",
      categoryId: food,
    });
    await add({
      date: "2026-09-20",
      merchant: "Grocer",
      amountMinor: 2000,
      direction: "out",
      categoryId: food,
    });
    await add({ date: "2026-09-22", merchant: "Bookshop", amountMinor: 1200, direction: "out" });
    await add({
      date: "2026-09-25",
      merchant: "Grocer refund",
      amountMinor: 500,
      direction: "in",
      categoryId: food,
    });
    await add({
      date: "2026-09-30",
      merchant: "Payment, thank you",
      amountMinor: 2500,
      direction: "in",
      isTransfer: true,
    });

    // No closing day yet: no periods.
    expect(
      (await t.call("get", `/api/accounts/${card}/statements`).expect(200)).body.periods,
    ).toEqual([]);
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: 15, dueDay: 10 })
      .expect(200);
    const listed = (await t.call("get", "/api/accounts?includeHidden=1").expect(200))
      .body as Array<{
      id: number;
      statementClosingDay: number | null;
    }>;
    expect(listed.find((a) => a.id === card)!.statementClosingDay).toBe(15);

    const s = statements(t.db, card, 3, "2026-10-20");
    const sept = s.periods.find((p) => p.start === "2026-09-16")!;
    expect(sept).toMatchObject({
      end: "2026-10-15",
      due: "2026-11-10",
      chargesMinor: 3200,
      paymentsMinor: 2500,
      creditsMinor: 500,
      netMinor: 200,
      count: 4,
    });
    expect(sept.categories).toEqual([
      expect.objectContaining({ name: "Food", spendingMinor: 1500 }),
      expect.objectContaining({ name: "Uncategorized", spendingMinor: 1200 }),
    ]);
    expect(sept.merchants[0]).toMatchObject({ name: "Grocer", spendingMinor: 2000, count: 1 });
    expect(s.periods.find((p) => p.start === "2026-08-16")!.chargesMinor).toBe(3000);

    // Each statement's new balance: what is owed today, less what posted after it closed.
    await add({ date: "2026-10-18", merchant: "Cafe", amountMinor: 1000, direction: "out" });
    t.db.update(accounts).set({ currentBalanceMinor: 9000 }).where(eq(accounts.id, card)).run();
    const b = statements(t.db, card, 3, "2026-10-20");
    expect(b.periods[0]).toMatchObject({
      current: true,
      newBalanceMinor: 9000,
      previousBalanceMinor: 8000,
    });
    expect(b.periods.find((p) => p.start === "2026-09-16")).toMatchObject({
      newBalanceMinor: 8000,
      previousBalanceMinor: 7800,
    });
    expect(b.periods.find((p) => p.start === "2026-08-16")).toMatchObject({
      newBalanceMinor: 7800,
      previousBalanceMinor: 4800,
    });
  });

  it("have no new balance when the bank gives none", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const card = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Visa", kind: "credit_card" })
        .expect(201)
    ).body.id as number;
    t.db.update(accounts).set({ currentBalanceMinor: null }).where(eq(accounts.id, card)).run();
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: 15, dueDay: 10 })
      .expect(200);
    expect(statements(t.db, card, 2, "2026-10-20").periods[1]!.newBalanceMinor).toBeNull();
  });

  it("are only for credit cards, and take days of the month", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const make = async (kind: string) =>
      (await t.call("post", "/api/accounts/manual").send({ name: kind, kind }).expect(201)).body
        .id as number;
    const checking = await make("checking");
    const card = await make("credit_card");
    await t
      .call("put", `/api/accounts/${checking}/statement-settings`)
      .send({ closingDay: 5 })
      .expect(409);
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: 32 })
      .expect(400);
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: null })
      .expect(200);
  });
});

describe("a card's closing and due days", () => {
  it("are the same on Card statements and Card bills, whichever page sets them", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const card = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Visa", kind: "credit_card" })
        .expect(201)
    ).body.id as number;
    const bill = async () =>
      (
        (await t.call("get", "/api/bills").expect(200)).body as Array<{
          accountId: number;
          settings: { closingDay: number; dueDay: number; minimumMinor: number | null } | null;
          statementDays: { closingDay: number; dueDay: number | null } | null;
        }>
      ).find((b) => b.accountId === card)!;
    const statementDays = async () => {
      const s = (await t.call("get", `/api/accounts/${card}/statements`).expect(200)).body;
      return { closingDay: s.closingDay, dueDay: s.dueDay };
    };

    // Set on Card statements: Card bills knows them, without counting the bill yet.
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: 15, dueDay: 10 })
      .expect(200);
    expect(await bill()).toMatchObject({
      settings: null,
      statementDays: { closingDay: 15, dueDay: 10 },
    });

    // Set on Card bills: Card statements uses them.
    await t
      .call("put", `/api/accounts/${card}/bill`)
      .send({ closingDay: 20, dueDay: 12, minimumMinor: 3500, autopay: false })
      .expect(200);
    expect(await statementDays()).toEqual({ closingDay: 20, dueDay: 12 });
    expect((await bill()).statementDays).toBeNull();

    // Changed on Card statements: the bill moves too and keeps its minimum.
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: 25, dueDay: 18 })
      .expect(200);
    expect((await bill()).settings).toMatchObject({
      closingDay: 25,
      dueDay: 18,
      minimumMinor: 3500,
    });
    // A bill needs a due day, so clearing only that one keeps the bill's.
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: 26, dueDay: null })
      .expect(200);
    expect(await statementDays()).toEqual({ closingDay: 26, dueDay: 18 });

    // No longer counted as a bill: the days stay for Card statements.
    await t.call("delete", `/api/accounts/${card}/bill`).expect(204);
    expect(await statementDays()).toEqual({ closingDay: 26, dueDay: 18 });
    expect(await bill()).toMatchObject({
      settings: null,
      statementDays: { closingDay: 26, dueDay: 18 },
    });

    // Cleared on Card statements: a card with no closing day has no bill either.
    await t
      .call("put", `/api/accounts/${card}/bill`)
      .send({ closingDay: 5, dueDay: 1, minimumMinor: null, autopay: true })
      .expect(200);
    await t
      .call("put", `/api/accounts/${card}/statement-settings`)
      .send({ closingDay: null })
      .expect(200);
    expect(await bill()).toMatchObject({ settings: null, statementDays: null });
  });

  it("set on Card bills before they were kept once reach the card's statements", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const card = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Visa", kind: "credit_card" })
        .expect(201)
    ).body.id as number;
    // A bill stored the old way: only on Card bills.
    t.db
      .insert(cardBills)
      .values({
        accountId: card,
        closingDay: 9,
        dueDay: 3,
        minimumMinor: null,
        autopay: false,
        createdAt: "",
        updatedAt: "",
      })
      .run();
    const migration = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../drizzle/migrations/0055_card_days_once.sql"),
      "utf8",
    );
    t.db.run(sql.raw(migration));
    const s = (await t.call("get", `/api/accounts/${card}/statements`).expect(200)).body;
    expect({ closingDay: s.closingDay, dueDay: s.dueDay }).toEqual({ closingDay: 9, dueDay: 3 });
  });
});

describe("every card's statements together", () => {
  it("groups statements by the month they close in and adds them up", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const make = async (name: string) =>
      (await t.call("post", "/api/accounts/manual").send({ name, kind: "credit_card" }).expect(201))
        .body.id as number;
    const early = await make("Closes early");
    const late = await make("Closes late");
    const unset = await make("No closing day");
    await t
      .call("put", `/api/accounts/${early}/statement-settings`)
      .send({ closingDay: 5, dueDay: 28 })
      .expect(200);
    await t
      .call("put", `/api/accounts/${late}/statement-settings`)
      .send({ closingDay: 25, dueDay: 20 })
      .expect(200);
    const food = (await t.call("post", "/api/categories").send({ name: "Food" }).expect(201)).body
      .id as number;
    const add = (accountId: number, date: string, merchant: string, amountMinor: number) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId, date, merchant, amountMinor, direction: "out", categoryId: food })
        .expect(201);
    // Both in statements that close in October: Sep 6 - Oct 5, and Sep 26 - Oct 25.
    await add(early, "2026-09-20", "Grocer", 3000);
    await add(late, "2026-10-10", "Grocer", 2000);
    await add(late, "2026-10-12", "Bookshop", 700);
    // Early card's November statement (Oct 6 - Nov 5).
    await add(early, "2026-10-10", "Cafe", 400);
    await add(unset, "2026-10-10", "Elsewhere", 9999);

    const all = combinedStatements(t.db, 3, "2026-11-11");
    expect(all.cards.map((c) => c.name)).toEqual(["Closes early", "Closes late"]);
    expect(all.withoutClosingDay.map((c) => c.name)).toEqual(["No closing day"]);
    // The early card's open statement closes in December; the late card's, in November.
    expect(all.months.map((m) => m.month)).toEqual(["2026-12", "2026-11", "2026-10"]);
    expect(all.months[0]!.cards.map((c) => c.accountId)).toEqual([early]);
    expect(all.months[0]!.open).toBe(true);

    const october = all.months[2]!;
    expect(october).toMatchObject({ open: false, chargesMinor: 5700, count: 3 });
    expect(october.cards).toHaveLength(2);
    expect(october.cards.find((c) => c.accountId === late)).toMatchObject({
      start: "2026-09-26",
      end: "2026-10-25",
      due: "2026-11-20",
      chargesMinor: 2700,
    });
    expect(october.categories).toEqual([
      expect.objectContaining({ name: "Food", spendingMinor: 5700 }),
    ]);
    expect(october.merchants[0]).toEqual({ name: "Grocer", spendingMinor: 5000, count: 2 });
    expect(all.months[1]).toMatchObject({ month: "2026-11", open: true, chargesMinor: 400 });

    const viaApi = await t.call("get", "/api/statements/combined?count=3").expect(200);
    expect(viaApi.body.cards).toHaveLength(2);
  });

  it("is empty when no card has a closing day", () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    expect(combinedStatements(t.db, 12, "2026-11-11")).toEqual({
      cards: [],
      withoutClosingDay: [],
      months: [],
    });
  });
});
