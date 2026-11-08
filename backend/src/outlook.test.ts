import { afterEach, describe, expect, it } from "vitest";
import { outlookInputs } from "./services/outlook.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";

describe("the long-range outlook's inputs", () => {
  it("are zeros on a new app", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const res = await t.call("get", `/api/outlook?today=${TODAY}`).expect(200);
    expect(res.body).toMatchObject({
      today: TODAY,
      cashMinor: 0,
      investmentsMinor: 0,
      debtMinor: 0,
      netWorthMinor: 0,
      monthlyIncomeMinor: 0,
      monthlySpendingMinor: 0,
      monthsAveraged: 0,
      debtFreeMonths: 0,
      goals: [],
    });
  });

  it("average the complete months that had any money in or out", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const checking = (
      await t.call("post", "/api/accounts/manual").send({ name: "Checking", kind: "checking" })
    ).body.id as number;
    // Money in counts as income under an income category, as the reports count it.
    const income = (await t.call("post", "/api/categories").send({ name: "Income" }).expect(201))
      .body.id as number;
    const add = (date: string, merchant: string, amountMinor: number, direction: "in" | "out") =>
      t
        .call("post", "/api/transactions")
        .send({
          accountId: checking,
          date,
          merchant,
          amountMinor,
          direction,
          categoryId: direction === "in" ? income : undefined,
        })
        .expect(201);
    await add("2026-08-20", "ACME PAYROLL", 300_000, "in");
    await add("2026-08-12", "Big shop", 100_000, "out");
    await add("2026-09-20", "ACME PAYROLL", 300_000, "in");
    await add("2026-09-12", "Small shop", 50_000, "out");
    // This month is not complete, so it is left out.
    await add("2026-10-02", "Huge shop", 900_000, "out");
    await t
      .call("post", "/api/goals")
      .send({ name: "House", targetMinor: 5_000_000, targetDate: "2030-06-01" })
      .expect(201);

    const o = outlookInputs(t.db, { today: TODAY });
    expect(o).toMatchObject({
      monthsAveraged: 2,
      monthlyIncomeMinor: 300_000,
      monthlySpendingMinor: 75_000,
      cashMinor: -450_000,
    });
    expect(o.goals).toEqual([
      { name: "House", targetDate: "2030-06-01", remainingMinor: 5_000_000 },
    ]);
  });
});
