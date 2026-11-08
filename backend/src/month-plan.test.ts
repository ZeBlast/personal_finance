import { afterEach, describe, expect, it } from "vitest";
import { seriesDatesIn } from "./services/plan-dates.js";
import { monthPlan, type MonthPlan } from "./services/month-plan.service.js";
import { makeTestApp } from "./test-helpers.js";
import { addMonths } from "./utils/dates.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";

describe("a series' dates in a span", () => {
  it("walks back from the last date, then forward", () => {
    expect(seriesDatesIn("2026-11-14", "biweekly", "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-03",
      "2026-10-17",
      "2026-10-31",
    ]);
  });
  it("continues forward past the last date", () => {
    expect(seriesDatesIn("2026-11-05", "monthly", "2026-12-01", "2026-12-31")).toEqual([
      "2026-12-05",
    ]);
    expect(seriesDatesIn("2026-03-10", "yearly", "2026-11-01", "2027-10-31")).toEqual([
      "2027-03-10",
    ]);
  });
  it("finds nothing in a span the series skips", () => {
    expect(seriesDatesIn("2026-01-15", "quarterly", "2026-05-01", "2026-06-30")).toEqual([]);
  });
});

const others = (p: MonthPlan) =>
  p.totals.bill + p.totals.cap + p.totals.usual + p.totals.goal + p.totals.debt;

describe("the month plan", () => {
  it("is empty on a new app", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const res = await t.call("get", `/api/month-plan?month=2026-10&today=${TODAY}`).expect(200);
    expect(res.body).toMatchObject({ month: "2026-10", lines: [], leftMinor: 0 });
  });

  it("refuses a month too far away", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t.call("get", `/api/month-plan?month=2028-01&today=${TODAY}`).expect(400);
    await t.call("get", `/api/month-plan?month=2025-01&today=${TODAY}`).expect(400);
  });

  it("puts income against bills, caps and goals, counting each once", async () => {
    // A cancelled subscription stops from the day it is marked, so this test runs on the real clock.
    const now = new Date().toISOString().slice(0, 10);
    const thisMonth = now.slice(0, 7);
    const nextMonth = addMonths(thisMonth, 1);
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const checking = (
      await t.call("post", "/api/accounts/manual").send({ name: "Checking", kind: "checking" })
    ).body.id as number;
    const utilities = (await t.call("post", "/api/categories").send({ name: "Power" }).expect(201))
      .body.id as number;
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
      const month = addMonths(thisMonth, k);
      await add(`${month}-20`, "ACME PAYROLL", 300_000, "in");
      await add(`${month}-05`, "City Power", 10_000, "out", utilities);
      await add(`${month}-15`, "STREAMFLIX", 1_500, "out");
    }
    await t
      .call("post", "/api/budgets")
      .send({ categoryId: utilities, month: nextMonth, amountMinor: 15_000 })
      .expect(201);
    await t
      .call("post", "/api/goals")
      .send({
        name: "Trip",
        targetMinor: 1_000_000,
        targetDate: "2099-01-01",
        forecast: { monthlyMinor: 20_000, day: 1 },
      })
      .expect(201);
    const recurring = await t.call("get", "/api/insights/recurring").expect(200);
    const stream = (recurring.body.series as Array<{ key: string; merchant: string }>).find(
      (s) => s.merchant === "STREAMFLIX",
    )!;
    await t
      .call("put", `/api/subscriptions/${encodeURIComponent(stream.key)}`)
      .send({ merchant: "STREAMFLIX", status: "cancelled" })
      .expect(200);

    const p = monthPlan(t.db, { month: nextMonth, today: now });
    expect(p.totals).toMatchObject({ income: 300_000, cap: 15_000, goal: 20_000, bill: 0 });
    expect(p.lines.find((l) => l.label === "City Power")).toBeUndefined();
    expect(p.lines.find((l) => l.label === "STREAMFLIX")).toBeUndefined();
    expect(p.lines).toContainEqual({ kind: "goal", label: "Trip", amountMinor: 20_000 });
    expect(p.leftMinor).toBe(p.totals.income - others(p));
    expect(p.actual).toBeNull();

    const current = monthPlan(t.db, { month: thisMonth, today: now });
    expect(current.actual).toMatchObject({ through: now });
  });
});
