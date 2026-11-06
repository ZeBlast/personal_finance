import { afterEach, describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import {
  forecastScenarios,
  goals,
  plannedTransactions,
  transactions,
} from "../../drizzle/schema.js";
import { cashForecast, lowestBalance } from "./services/forecast.service.js";
import { compareScenario, type ScenarioAdjustment } from "./services/scenario.service.js";
import { getSettings } from "./services/settings.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";

/** Payroll on the 20th, City Apartments $1,500 on the 12th, a goal counting $400 on the 5th, and a card with Netflix. */
async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = async (name: string, kind: string) =>
    (await t.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
  const checking = await account("Checking", "checking");
  const card = await account("Visa", "credit_card");
  await t
    .call("put", `/api/accounts/${card}/bill`)
    .send({ closingDay: 25, dueDay: 20 })
    .expect(200);
  const add = (
    accountId: number,
    date: string,
    merchant: string,
    amountMinor: number,
    direction: "in" | "out",
  ) =>
    t
      .call("post", "/api/transactions")
      .send({ accountId, date, merchant, amountMinor, direction })
      .expect(201);
  for (const month of ["06", "07", "08", "09"]) {
    await add(checking, `2026-${month}-20`, "ACME PAYROLL", 300_000, "in");
    await add(checking, `2026-${month}-12`, "City Apartments", 150_000, "out");
    await add(card, `2026-${month}-15`, "Netflix", 1599, "out");
  }
  const goalId = (
    await t
      .call("post", "/api/goals")
      .send({
        name: "Trip",
        targetMinor: 5_000_000,
        forecast: { monthlyMinor: 40_000, day: 5 },
      })
      .expect(201)
  ).body.id as number;

  const events = (f: ReturnType<typeof cashForecast>, label: string) =>
    f.days.flatMap((d) =>
      d.events
        .filter((e) => e.label === label)
        .map((e) => ({ date: d.date, amountMinor: e.amountMinor })),
    );
  const base = cashForecast(t.db, { today: TODAY, days: 60 });
  const keyOf = (label: string) =>
    base.days.flatMap((d) => d.events).find((e) => e.label === label)!.seriesKey!;

  async function compare(adjustments: ScenarioAdjustment[], days = 60) {
    const made = await t
      .call("post", "/api/forecast/scenarios")
      .send({ name: "What if", adjustments })
      .expect(201);
    const res = await t
      .call("get", `/api/forecast/scenarios/${made.body.id}/compare?days=${days}&today=${TODAY}`)
      .expect(200);
    return res.body as ReturnType<typeof compareScenario>;
  }
  return { t, checking, goalId, events, base, keyOf, compare };
}

describe("what-if scenarios", () => {
  it("a one-off expense lowers the line from its day on", async () => {
    const s = await setup();
    const c = await s.compare(
      [{ kind: "one_off", label: "Car repair", date: "2026-10-15", amountMinor: -50_000 }],
      60,
    );
    expect(c).toMatchObject({ endChangeMinor: -50_000, lowestChangeMinor: -50_000 });
    expect(c.alt.days.find((d) => d.date === "2026-10-15")!.events[0]).toMatchObject({
      source: "scenario",
    });
  });

  it("stopping a series removes its later events, and changing it changes their amount", async () => {
    const s = await setup();
    const rentKey = s.keyOf("City Apartments");
    const stop = await s.compare(
      [
        {
          kind: "change_series",
          target: { seriesKey: rentKey },
          fromDate: "2026-11-01",
          amountMinor: null,
        },
      ],
      60,
    );
    expect(s.events(stop.alt, "City Apartments").map((e) => e.amountMinor)).toEqual([-150_000]);
    const raise = await s.compare(
      [
        {
          kind: "change_series",
          target: { seriesKey: rentKey },
          fromDate: "2026-11-01",
          amountMinor: 170_000,
        },
      ],
      60,
    );
    expect(raise.endChangeMinor).toBe(-20_000);
  });

  it("moves a card-paid series with its bill when it is stopped", async () => {
    const s = await setup();
    const key = s.keyOf("Netflix");
    const full = cashForecast(s.t.db, { today: TODAY, days: 90 });
    expect(s.events(full, "Netflix").map((e) => e.date)).toEqual(["2026-11-20", "2026-12-20"]);
    const stop = await s.compare(
      [
        {
          kind: "change_series",
          target: { seriesKey: key },
          fromDate: "2026-11-01",
          amountMinor: null,
        },
      ],
      90,
    );
    // Oct 15 stays (on the bill due Nov 20); Nov 15 is on the bill due Dec 20 and goes.
    expect(s.events(stop.alt, "Netflix")).toEqual([{ date: "2026-11-20", amountMinor: -1599 }]);
  });

  it("adds a new monthly amount, and replaces a goal's own contribution", async () => {
    const s = await setup();
    const gym = await s.compare(
      [
        {
          kind: "recurring",
          label: "Gym",
          amountMinor: -5_000,
          cadence: "monthly",
          startDate: "2026-10-15",
          endDate: null,
        },
      ],
      60,
    );
    // Oct 15 and Nov 15 and Dec 15 are inside 60 days (to Dec 8): two charges.
    expect(gym.endChangeMinor).toBe(-10_000);
    const goal = await s.compare(
      [{ kind: "goal", goalId: s.goalId, forecast: { monthlyMinor: 10_000, day: 5 } }],
      60,
    );
    expect(s.events(goal.alt, "Set aside for Trip").map((e) => e.amountMinor)).toEqual([
      -10_000, -10_000,
    ]);
    expect(goal.endChangeMinor).toBe(60_000);
  });

  it("never changes the ledger, the plan, goals or settings", async () => {
    const s = await setup();
    const snapshot = () => ({
      tx: s.t.db.select({ n: count() }).from(transactions).get(),
      planned: s.t.db.select({ n: count() }).from(plannedTransactions).get(),
      goals: s.t.db.select().from(goals).all(),
      settings: getSettings(s.t.db),
      forecast: cashForecast(s.t.db, { today: TODAY, days: 60 }),
    });
    const before = snapshot();
    await s.compare(
      [
        { kind: "one_off", label: "x", date: "2026-10-15", amountMinor: -1 },
        { kind: "goal", goalId: s.goalId, forecast: null },
        {
          kind: "change_series",
          target: { seriesKey: s.keyOf("City Apartments") },
          fromDate: "2026-10-01",
          amountMinor: null,
        },
      ],
      60,
    );
    expect(snapshot()).toEqual(before);
    const res = await s.t.call("get", `/api/forecast?today=${TODAY}&days=60`).expect(200);
    expect(res.body).toEqual(before.forecast);

    await s.t
      .call("post", "/api/forecast/scenarios")
      .send({
        name: "Bad",
        adjustments: [{ kind: "one_off", label: "x", date: "2026-13-01", amountMinor: 5 }],
      })
      .expect(400);
    await s.t
      .call("post", "/api/forecast/scenarios")
      .send({
        name: "Zero",
        adjustments: [{ kind: "one_off", label: "x", date: "2026-10-15", amountMinor: 0 }],
      })
      .expect(400);
  });

  it("lists, renames and deletes scenarios", async () => {
    const s = await setup();
    const made = await s.t
      .call("post", "/api/forecast/scenarios")
      .send({ name: "A", adjustments: [] })
      .expect(201);
    const id = made.body.id as number;
    await s.t
      .call("put", `/api/forecast/scenarios/${id}`)
      .send({ name: "B", adjustments: [] })
      .expect(200);
    expect((await s.t.call("get", "/api/forecast/scenarios").expect(200)).body).toMatchObject([
      { id, name: "B", adjustments: [] },
    ]);
    await s.t.call("delete", `/api/forecast/scenarios/${id}`).expect(204);
    await s.t.call("get", `/api/forecast/scenarios/${id}/compare`).expect(404);
  });

  it("reports adjustments that match nothing", async () => {
    const s = await setup();
    const c = await s.compare([
      { kind: "one_off", label: "x", date: "2026-10-15", amountMinor: -1 },
      {
        kind: "change_series",
        target: { seriesKey: "gone:key" },
        fromDate: "2026-11-01",
        amountMinor: null,
      },
      {
        kind: "change_series",
        target: { plannedId: 9999 },
        fromDate: "2026-11-01",
        amountMinor: 5,
      },
      { kind: "goal", goalId: 9999, forecast: null },
      {
        kind: "change_series",
        target: { seriesKey: s.keyOf("City Apartments") },
        fromDate: "2026-11-01",
        amountMinor: null,
      },
      { kind: "goal", goalId: s.goalId, forecast: null },
    ]);
    expect(c.unmatched).toEqual([1, 2, 3]);
  });

  it("keeps a recurring amount with an old start date, and stops it at its end date", async () => {
    const s = await setup();
    const old = await s.compare([
      {
        kind: "recurring",
        label: "Old",
        amountMinor: -1_000,
        cadence: "weekly",
        startDate: "2016-10-10",
        endDate: null,
      },
    ]);
    // 2016-10-10 was a Monday: Mondays after Oct 9, 2026 up to Dec 8 are 9 days of the 60.
    expect(s.events(old.alt, "Old")).toHaveLength(9);
    const ended = await s.compare([
      {
        kind: "recurring",
        label: "Ends",
        amountMinor: -1_000,
        cadence: "weekly",
        startDate: "2026-10-12",
        endDate: "2026-10-26",
      },
    ]);
    expect(s.events(ended.alt, "Ends").map((e) => e.date)).toEqual([
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
  });

  it("changes an expected transaction by its plan", async () => {
    const s = await setup();
    const planned = await s.t
      .call("post", "/api/planned")
      .send({
        merchant: "Tax bill",
        amountMinor: 80_000,
        direction: "out",
        accountId: s.checking,
        startDate: "2026-10-25",
        frequency: "once",
      })
      .expect(201);
    const c = await s.compare([
      {
        kind: "change_series",
        target: { plannedId: planned.body.id },
        fromDate: "2026-10-01",
        amountMinor: 100_000,
      },
    ]);
    expect(s.events(c.alt, "Tax bill")).toEqual([{ date: "2026-10-25", amountMinor: -100_000 }]);
    expect(c.endChangeMinor).toBe(-20_000);
    expect(c.unmatched).toEqual([]);
  });

  it("reports a change whose days are all before today", async () => {
    const s = await setup();
    const c = await s.compare([
      { kind: "one_off", label: "Old", date: "2026-10-01", amountMinor: -1_000 },
      { kind: "one_off", label: "Today", date: TODAY, amountMinor: -1_000 },
      { kind: "one_off", label: "Soon", date: "2026-10-15", amountMinor: -1_000 },
      {
        kind: "recurring",
        label: "Over",
        amountMinor: -1_000,
        cadence: "weekly",
        startDate: "2026-08-01",
        endDate: "2026-09-01",
      },
      {
        kind: "recurring",
        label: "Still on",
        amountMinor: -1_000,
        cadence: "weekly",
        startDate: "2026-08-01",
        endDate: null,
      },
    ]);
    expect(c.unmatched).toEqual([0, 1, 3]);
  });

  it("measures the lowest point after today when today is the low point", () => {
    const day = (date: string, balanceMinor: number) => ({
      date,
      balanceMinor,
      changeMinor: 0,
      events: [],
    });
    const days = [day("2026-10-09", 100), day("2026-10-10", 300), day("2026-10-11", 200)];
    expect(
      lowestBalance({
        today: "2026-10-09",
        lowest: { date: "2026-10-09", balanceMinor: 100 },
        days,
      }),
    ).toBe(200);
    expect(
      lowestBalance({
        today: "2026-10-09",
        lowest: { date: "2026-10-11", balanceMinor: 50 },
        days,
      }),
    ).toBe(50);
  });

  it("gives a goal that is already met no events", async () => {
    const s = await setup();
    const met = (
      await s.t
        .call("post", "/api/goals")
        .send({ name: "Done", targetMinor: 100_000, savedMinor: 100_000 })
        .expect(201)
    ).body.id as number;
    const c = await s.compare([
      { kind: "goal", goalId: met, forecast: { monthlyMinor: 10_000, day: 5 } },
    ]);
    expect(s.events(c.alt, "Set aside for Done")).toEqual([]);
    expect(c.unmatched).toEqual([]);
  });

  it("skips stored adjustments it cannot read instead of failing", async () => {
    const s = await setup();
    const made = await s.t
      .call("post", "/api/forecast/scenarios")
      .send({
        name: "Old",
        adjustments: [{ kind: "one_off", label: "x", date: "2026-10-15", amountMinor: -5 }],
      })
      .expect(201);
    s.t.db
      .update(forecastScenarios)
      .set({
        adjustments: JSON.stringify([
          { kind: "one_off", label: "x", date: "2026-10-15", amountMinor: -5 },
          { kind: "mystery" },
        ]),
      })
      .run();
    const c = (
      await s.t
        .call("get", `/api/forecast/scenarios/${made.body.id}/compare?today=${TODAY}`)
        .expect(200)
    ).body as ReturnType<typeof compareScenario>;
    expect(c.scenario).toMatchObject({ skipped: 1 });
    expect(c.scenario.adjustments).toHaveLength(1);
  });
});

describe("previewing what-ifs that are not saved", () => {
  const rise: ScenarioAdjustment = {
    kind: "one_off",
    label: "Car repair",
    date: "2026-10-15",
    amountMinor: -50_000,
  };
  const preview = (s: Awaited<ReturnType<typeof setup>>, body: object) =>
    s.t.call("post", "/api/forecast/scenarios/preview").send({ today: TODAY, ...body });

  it("returns what compare returns for the same adjustments", async () => {
    const s = await setup();
    const saved = await s.compare([rise], 60);
    const res = await preview(s, { adjustments: [rise], days: 60 }).expect(200);
    expect(res.body.alt).toEqual(saved.alt);
    expect(res.body.base).toEqual(saved.base);
    expect(res.body).toMatchObject({
      lowestChangeMinor: saved.lowestChangeMinor,
      endChangeMinor: saved.endChangeMinor,
      unmatched: saved.unmatched,
    });
  });

  it("lowers the lowest point by a one-off that lands before the low", async () => {
    const s = await setup();
    const res = await preview(s, { adjustments: [rise], days: 60 }).expect(200);
    expect(res.body.lowestChangeMinor).toBe(-50_000);
    expect(lowestBalance(res.body.alt)).toBe(lowestBalance(res.body.base) - 50_000);
  });

  it("refuses an empty list, a bad date and 51 entries", async () => {
    const s = await setup();
    await preview(s, { adjustments: [] }).expect(400);
    await preview(s, { adjustments: [{ ...rise, date: "2026-02-31" }] }).expect(400);
    await preview(s, { adjustments: Array.from({ length: 51 }, () => rise) }).expect(400);
  });

  it("writes nothing", async () => {
    const s = await setup();
    const forecastUrl = `/api/forecast?days=60&today=${TODAY}`;
    const before = (await s.t.call("get", forecastUrl)).body;
    await preview(s, { adjustments: [rise], days: 60 }).expect(200);
    const list = await s.t.call("get", "/api/forecast/scenarios").expect(200);
    expect(list.body).toEqual([]);
    expect((await s.t.call("get", forecastUrl)).body).toEqual(before);
  });
});
