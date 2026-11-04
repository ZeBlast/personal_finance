import { afterEach, describe, expect, it } from "vitest";
import { divideAccount, goalReservations, monthsBetween } from "./services/goal.service.js";
import { goalEvents } from "./services/forecast.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("goals", () => {
  it("count linked accounts and money kept elsewhere, and say what a month it takes", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const savings = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Savings", kind: "savings", openingBalanceMinor: 300_000 })
        .expect(201)
    ).body.id as number;
    const card = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Card", kind: "credit_card", openingBalanceMinor: 50_000 })
        .expect(201)
    ).body.id as number;
    const created = await t
      .call("post", "/api/goals")
      .send({
        name: "Emergency fund",
        targetMinor: 1_000_000,
        targetDate: "2099-01-15",
        savedMinor: 100_000,
        accountIds: [savings, card],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      name: "Emergency fund",
      // $3,000 in savings + $1,000 kept elsewhere; what the card owes is not savings.
      currentMinor: 400_000,
      remainingMinor: 600_000,
      percent: 40,
      reached: false,
      overdue: false,
    });
    expect(created.body.perMonthMinor).toBe(Math.ceil(600_000 / created.body.monthsLeft));

    const id = created.body.id as number;
    const done = await t
      .call("put", `/api/goals/${id}`)
      .send({ name: "Emergency fund", targetMinor: 300_000, accountIds: [savings] })
      .expect(200);
    expect(done.body).toMatchObject({
      reached: true,
      percent: 100,
      perMonthMinor: null,
      monthsLeft: null,
    });
    expect((await t.call("get", "/api/goals").expect(200)).body).toHaveLength(1);
    await t.call("delete", `/api/goals/${id}`).expect(204);
    expect((await t.call("get", "/api/goals").expect(200)).body).toHaveLength(0);
    await t.call("post", "/api/goals").send({ name: "", targetMinor: 100 }).expect(400);
  });

  it("counts a goal's monthly contribution until it is met", () => {
    const g = {
      id: 1,
      name: "Trip",
      remainingMinor: 100_000,
      reached: false,
      forecast: { monthlyMinor: 40_000, day: 5 },
    };
    expect(
      goalEvents([g], "2026-10-09", "2027-03-01").map((e) => [e.date, e.event.amountMinor]),
    ).toEqual([
      ["2026-11-05", -40_000],
      ["2026-12-05", -40_000],
      ["2027-01-05", -20_000],
    ]);
    expect(goalEvents([g], "2026-10-04", "2026-10-31")[0]!.date).toBe("2026-10-05");
    expect(goalEvents([{ ...g, reached: true }], "2026-10-09", "2027-03-01")).toEqual([]);
    expect(goalEvents([{ ...g, forecast: null }], "2026-10-09", "2027-03-01")).toEqual([]);
  });

  it("keeps the forecast choice through an edit and shows it in the forecast", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const body = {
      name: "Trip",
      targetMinor: 1_000_000,
      forecast: { monthlyMinor: 40_000, day: 5 },
    };
    const created = await t.call("post", "/api/goals").send(body).expect(201);
    expect(created.body.forecast).toEqual({ monthlyMinor: 40_000, day: 5 });
    const put = await t
      .call("put", `/api/goals/${created.body.id}`)
      .send({ ...body, name: "Big trip" })
      .expect(200);
    expect(put.body.forecast).toEqual({ monthlyMinor: 40_000, day: 5 });
    const f = (await t.call("get", "/api/forecast?days=60&today=2026-10-09").expect(200)).body;
    expect(f.days.find((d: { date: string }) => d.date === "2026-11-05").events).toContainEqual(
      expect.objectContaining({
        label: "Set aside for Big trip",
        source: "goal",
        amountMinor: -40_000,
      }),
    );
    const cleared = await t
      .call("put", `/api/goals/${created.body.id}`)
      .send({ ...body, forecast: null })
      .expect(200);
    expect(cleared.body.forecast).toBeNull();
    await t
      .call("post", "/api/goals")
      .send({ ...body, forecast: { monthlyMinor: 5, day: 29 } })
      .expect(400);
  });

  it("counts whole months to the date, at least one", () => {
    expect(monthsBetween("2026-10-10", "2026-10-31")).toBe(1);
    expect(monthsBetween("2026-10-10", "2027-01-10")).toBe(3);
    expect(monthsBetween("2026-10-10", "2027-01-11")).toBe(4);
  });

  it("divide an account: set amounts first, oldest first, then even shares of the rest", () => {
    const share = divideAccount(10_001, [
      { goalId: 1, setMinor: null },
      { goalId: 2, setMinor: 4_000 },
      { goalId: 3, setMinor: null },
    ]);
    expect(share.get(2)).toEqual({ countedMinor: 4_000, short: false });
    expect(share.get(1)).toEqual({ countedMinor: 3_001, short: false });
    expect(share.get(3)).toEqual({ countedMinor: 3_000, short: false });
    const tight = divideAccount(5_000, [
      { goalId: 1, setMinor: 4_000 },
      { goalId: 2, setMinor: 4_000 },
    ]);
    expect(tight.get(1)).toEqual({ countedMinor: 4_000, short: false });
    expect(tight.get(2)).toEqual({ countedMinor: 1_000, short: true });
  });

  it("never let two goals count the same money in a shared account", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const savings = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Savings", kind: "savings", openingBalanceMinor: 500_000 })
        .expect(201)
    ).body.id as number;
    await t
      .call("post", "/api/goals")
      .send({ name: "Emergency", targetMinor: 1_000_000, accountIds: [savings] })
      .expect(201);
    await t
      .call("post", "/api/goals")
      .send({
        name: "Car",
        targetMinor: 1_000_000,
        accountIds: [savings],
        accountAmounts: { [savings]: 150_000 },
      })
      .expect(201);
    const [emergency, car] = (await t.call("get", "/api/goals").expect(200)).body;
    expect(car).toMatchObject({ currentMinor: 150_000 });
    expect(car.accounts[0]).toMatchObject({ setMinor: 150_000, sharedWith: ["Emergency"] });
    expect(emergency).toMatchObject({ currentMinor: 350_000 });
    expect(emergency.accounts[0]).toMatchObject({ setMinor: null, balanceMinor: 500_000 });
    expect(goalReservations(t.db).get(savings)).toBe(500_000);
  });
});
