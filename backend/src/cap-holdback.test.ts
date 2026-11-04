import { afterEach, describe, expect, it } from "vitest";
import { capHoldBack } from "./services/cap-holdback.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const parentOf = new Map<number, number | null>([
  [1, null],
  [2, 1],
  [3, null],
]);
const food = { categoryId: 1, categoryName: "Food", remainingMinor: 10_000 };

describe("capHoldBack", () => {
  it("holds back what is left of each cap, less what is already forecast, spread over the days left", () => {
    const r = capHoldBack({
      today: "2026-10-26",
      parentOf,
      caps: [{ categoryId: 3, categoryName: "Dining", remainingMinor: 30_000 }],
      forecastOut: [{ date: "2026-10-28", categoryId: 3, amountMinor: 10_000 }],
    });
    expect(r.days).toEqual(
      ["27", "28", "29", "30", "31"].map((d) => ({ date: `2026-10-${d}`, amountMinor: 4_000 })),
    );
    expect(r.caps).toEqual([
      { categoryName: "Dining", heldMinor: 20_000, alreadyForecastMinor: 10_000 },
    ]);
  });

  it("holds back nothing for an overspent cap or a capped child of a capped parent, and puts the remainder last", () => {
    const r = capHoldBack({
      today: "2026-10-28",
      parentOf,
      forecastOut: [],
      caps: [
        food,
        { categoryId: 2, categoryName: "Groceries", remainingMinor: 8_000 },
        { categoryId: 3, categoryName: "Dining", remainingMinor: -5_000 },
      ],
    });
    expect(r.totalMinor).toBe(10_000);
    expect(r.caps.map((c) => c.categoryName)).toEqual(["Food"]);
    expect(r.days.map((d) => d.amountMinor)).toEqual([3_333, 3_333, 3_334]);
    expect(
      capHoldBack({ today: "2026-10-31", parentOf, forecastOut: [], caps: [food] }).days,
    ).toEqual([]);
  });

  it("counts spending forecast in a subcategory against its capped parent, never below zero", () => {
    const r = capHoldBack({
      today: "2026-10-28",
      parentOf,
      caps: [food],
      forecastOut: [
        { date: "2026-10-29", categoryId: 2, amountMinor: 4_000 },
        // Past the month end, so it belongs to next month's caps.
        { date: "2026-11-02", categoryId: 1, amountMinor: 99_000 },
      ],
    });
    expect(r.caps).toEqual([
      { categoryName: "Food", heldMinor: 6_000, alreadyForecastMinor: 4_000 },
    ]);
    const over = capHoldBack({
      today: "2026-10-28",
      parentOf,
      caps: [food],
      forecastOut: [{ date: "2026-10-29", categoryId: 1, amountMinor: 50_000 }],
    });
    expect(over).toEqual({ days: [], caps: [], totalMinor: 0 });
  });
});

describe("cap hold-back in the forecast", () => {
  it("adds the hold-back to the forecast only when the setting is on", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking", openingBalanceMinor: 500_000 })
        .expect(201)
    ).body.id as number;
    const dining = (await t.call("post", "/api/categories").send({ name: "Dining" }).expect(201))
      .body.id as number;
    await t
      .call("post", "/api/budgets")
      .send({ categoryId: dining, month: "2026-10", amountMinor: 30_000 })
      .expect(201);
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: checking,
        date: "2026-10-20",
        merchant: "Bistro",
        amountMinor: 10_000,
        direction: "out",
        categoryId: dining,
      })
      .expect(201);
    const forecast = async () =>
      (await t.call("get", "/api/forecast?days=30&today=2026-10-26").expect(200)).body;

    const off = await forecast();
    expect(off.capHoldBack).toEqual({ included: false, totalMinor: 0, caps: [] });

    await t.call("patch", "/api/settings").send({ forecastHoldCaps: true }).expect(200);
    const f = await forecast();
    expect(f.capHoldBack).toMatchObject({ included: true, totalMinor: 20_000 });
    expect(f.days.find((d: { date: string }) => d.date === "2026-10-27").events).toContainEqual(
      expect.objectContaining({
        source: "cap_holdback",
        label: "Spending caps (rest of October)",
        amountMinor: -4_000,
      }),
    );

    // Something expected in the category is already in the forecast, so less is held back.
    await t
      .call("post", "/api/planned")
      .send({
        merchant: "Dinner out",
        amountMinor: 5_000,
        direction: "out",
        accountId: checking,
        categoryId: dining,
        startDate: "2026-10-28",
        frequency: "once",
      })
      .expect(201);
    const g = await forecast();
    expect(g.capHoldBack).toMatchObject({ totalMinor: 15_000 });
    expect(g.capHoldBack.caps).toEqual([
      { categoryName: "Dining", heldMinor: 15_000, alreadyForecastMinor: 5_000 },
    ]);
  });
});
