import { afterEach, describe, expect, it } from "vitest";
import { monthsBetween } from "./services/goal.service.js";
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

  it("counts whole months to the date, at least one", () => {
    expect(monthsBetween("2026-10-10", "2026-10-31")).toBe(1);
    expect(monthsBetween("2026-10-10", "2027-01-10")).toBe(3);
    expect(monthsBetween("2026-10-10", "2027-01-11")).toBe(4);
  });
});
