import { afterEach, describe, expect, it } from "vitest";
import { statementPeriods, statements } from "./services/statement.service.js";
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
