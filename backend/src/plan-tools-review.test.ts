import { afterEach, describe, expect, it } from "vitest";
import { monthPlan } from "./services/month-plan.service.js";
import { outlookInputs } from "./services/outlook.service.js";
import { seriesDatesIn } from "./services/plan-dates.js";
import { yearAhead } from "./services/year-ahead.service.js";
import { makeTestApp } from "./test-helpers.js";
import { addMonths } from "./utils/dates.js";

/** Cases found in the whole-branch review of the planning tools. */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("twice-a-month pay", () => {
  it("falls on two days a month, not every fifteen days", () => {
    expect(seriesDatesIn("2026-11-01", "semimonthly", "2026-12-01", "2026-12-31")).toEqual([
      "2026-12-01",
      "2026-12-16",
    ]);
    expect(seriesDatesIn("2026-11-15", "semimonthly", "2027-02-01", "2027-02-28")).toEqual([
      "2027-02-15",
      "2027-02-28",
    ]);
  });
});

// Recurring series are found from recent history, so these run on the real clock.
const now = new Date().toISOString().slice(0, 10);
const thisMonth = now.slice(0, 7);
const nextMonth = addMonths(thisMonth, 1);

async function household() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const checking = (
    await t.call("post", "/api/accounts/manual").send({ name: "Checking", kind: "checking" })
  ).body.id as number;
  const cat = async (name: string, parentId?: number) =>
    (await t.call("post", "/api/categories").send({ name, parentId }).expect(201)).body
      .id as number;
  const income = await cat("Income");
  const food = await cat("Food");
  const restaurants = await cat("Restaurants", food);
  const utilities = await cat("Utilities");
  const electric = await cat("Electric", utilities);
  const add = (
    date: string,
    merchant: string,
    amountMinor: number,
    direction: "in" | "out",
    categoryId?: number,
  ) =>
    t
      .call("post", "/api/transactions")
      .send({ accountId: checking, date, merchant, amountMinor, direction, categoryId })
      .expect(201);
  for (const k of [-4, -3, -2, -1]) {
    const m = addMonths(thisMonth, k);
    await add(`${m}-20`, "ACME PAYROLL", 300_000, "in", income);
    await add(`${m}-07`, "COMCAST", 8_000, "out");
    await add(`${m}-10`, `Market ${k}`, 30_000, "out", food);
    await add(`${m}-11`, `Diner ${k}`, 10_000, "out", restaurants);
    await add(`${m}-05`, "City Electric", 12_000, "out", electric);
    // Odd jobs around the house: not recurring, so they are usual spending.
    await add(`${m}-25`, `Hardware ${k}`, 6_000, "out", utilities);
  }
  return { t, food, restaurants };
}

describe("the month plan, after review", () => {
  it("counts a parent's cap once when a subcategory is capped too", async () => {
    const { t, food, restaurants } = await household();
    for (const [categoryId, amountMinor] of [
      [food, 60_000],
      [restaurants, 20_000],
    ] as const) {
      await t
        .call("post", "/api/budgets")
        .send({ categoryId, month: nextMonth, amountMinor })
        .expect(201);
    }
    expect(monthPlan(t.db, { month: nextMonth, today: now }).totals.cap).toBe(60_000);
    const y = yearAhead(t.db, { today: now });
    expect(y.months.find((m) => m.month === nextMonth)!.capsMinor).toBe(60_000);
  });

  it("keeps a monthly bill when a one-off of the same name is expected another month", async () => {
    const { t } = await household();
    await t
      .call("post", "/api/planned")
      .send({
        merchant: "Comcast",
        amountMinor: 5_000,
        direction: "out",
        startDate: `${addMonths(thisMonth, 3)}-15`,
        frequency: "once",
      })
      .expect(201);
    const p = monthPlan(t.db, { month: nextMonth, today: now });
    expect(p.lines).toContainEqual(
      expect.objectContaining({ kind: "bill", label: "COMCAST", amountMinor: 8_000 }),
    );
  });

  it("takes bills off their own category's usual spending, in months ahead too", async () => {
    const { t } = await household();
    for (const month of [nextMonth, addMonths(thisMonth, 4)]) {
      const p = monthPlan(t.db, { month, today: now });
      const usual = (label: string) =>
        p.lines.find((l) => l.kind === "usual" && l.label === label)?.amountMinor;
      // Utilities: 18,000 a month, 12,000 of it the electric bill.
      expect(usual("Utilities")).toBe(6_000);
      expect(usual("Food")).toBe(40_000);
      // Comcast is all of the uncategorized spending, and it is a bill.
      expect(usual("Uncategorized")).toBeUndefined();
    }
  });
});

describe("the year ahead, after review", () => {
  it("counts usual spending without a cap", async () => {
    const { t } = await household();
    const m = yearAhead(t.db, { today: now }).months.find((x) => x.month === nextMonth)!;
    expect(m.usualMinor).toBe(46_000);
    expect(m.netMinor).toBe(m.incomeMinor - m.billsMinor - m.capsMinor - m.usualMinor);
  });
});

describe("the outlook's inputs, after review", () => {
  it("say how much debt is outside the payoff plan, and what the plan pays", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Mortgage", kind: "loan", openingBalanceMinor: 30_000_000 })
      .expect(201);
    const o = outlookInputs(t.db, { today: now });
    expect(o.debtMinor).toBe(30_000_000);
    expect(o.debtOutsidePlanMinor).toBe(30_000_000);
    expect(o.debtPayments).toEqual({ cardMinor: 0, loanMinor: 0 });
  });
});
