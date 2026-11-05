import { afterEach, describe, expect, it } from "vitest";
import { isMonthComplete } from "./services/history-coverage.service.js";
import { spendingMonitor } from "./services/monitor.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const card = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Card", kind: "credit_card" })
      .expect(201)
  ).body.id as number;
  const add = async (date: string, merchant: string, amountMinor: number) =>
    (
      await t
        .call("post", "/api/transactions")
        .send({ accountId: card, date, merchant, amountMinor, direction: "out" })
        .expect(201)
    ).body.id as number;
  return { t, card, add };
}

describe("tags", () => {
  it("label transactions across categories, one name each whatever the case", async () => {
    const { t, add } = await setup();
    const a = await add("2026-10-02", "Hotel", 20_000);
    const trip = (await t.call("post", "/api/tags").send({ name: "Lisbon trip" }).expect(201)).body;
    // The same name again is the same tag.
    expect(
      (await t.call("post", "/api/tags").send({ name: "lisbon  TRIP" }).expect(201)).body.id,
    ).toBe(trip.id);
    await t
      .call("put", `/api/transactions/${a}/tags`)
      .send({ tagIds: [trip.id] })
      .expect(200);
    expect((await t.call("get", `/api/transactions/${a}/tags`).expect(200)).body).toEqual([
      { id: trip.id, name: "Lisbon trip", color: null },
    ]);
    expect((await t.call("get", "/api/tags").expect(200)).body[0].transactionCount).toBe(1);
    await t
      .call("put", `/api/transactions/${a}/tags`)
      .send({ tagIds: [999] })
      .expect(400);
    const other = (await t.call("post", "/api/tags").send({ name: "Work" }).expect(201)).body;
    await t.call("put", `/api/tags/${other.id}`).send({ name: "LISBON TRIP" }).expect(409);
    await t.call("delete", `/api/tags/${trip.id}`).expect(204);
    expect((await t.call("get", `/api/transactions/${a}/tags`).expect(200)).body).toEqual([]);
  });
});

describe("spending monitors", () => {
  it("compare this month so far with the same days of recent months, and project the month", async () => {
    const { t, add } = await setup();
    for (const m of ["07", "08", "09"]) {
      await add(`2026-${m}-05`, "Corner Coffee", 1_000);
      await add(`2026-${m}-25`, "Corner Coffee", 2_000);
      await add(`2026-${m}-06`, "Bookshop", 9_000);
    }
    await add("2026-10-03", "Corner Coffee", 1_500);
    await add("2026-10-08", "Corner Coffee", 1_500);
    const m = spendingMonitor(t.db, { merchant: "coffee" }, "2026-10-10");
    expect(m.spentMinor).toBe(3_000);
    expect(m.averageMinor).toBe(3_000);
    // By the 10th of each month before, only the $10 coffee on the 5th.
    expect(m.sameDayAverageMinor).toBe(1_000);
    expect(m.changePercent).toBe(200);
    expect(m.projectedMinor).toBe(Math.round((3_000 / 10) * 31));
    expect(m.months.map((x) => x.month)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);

    // By tag.
    const id = await add("2026-10-09", "Airline", 40_000);
    const tag = (await t.call("post", "/api/tags").send({ name: "Trip" }).expect(201)).body;
    await t
      .call("put", `/api/transactions/${id}/tags`)
      .send({ tagIds: [tag.id] })
      .expect(200);
    expect(spendingMonitor(t.db, { tag: "trip" }, "2026-10-10").spentMinor).toBe(40_000);
    expect(spendingMonitor(t.db, { tag: "nope" }, "2026-10-10")).toMatchObject({
      spentMinor: 0,
      unknownTag: true,
    });
    const res = await t
      .call("get", "/api/analytics/monitor?merchant=coffee&today=2026-10-10")
      .expect(200);
    expect(res.body.spentMinor).toBe(3_000);
  });

  it("leaves months before an account's history out of the baseline", async () => {
    const { t, add } = await setup();
    await add("2026-08-15", "Shop", 9_000);
    await add("2026-09-10", "Shop", 3_000);
    await add("2026-10-05", "Shop", 1_000);
    const m = spendingMonitor(t.db, {}, "2026-10-20");
    expect(m.baselineMonths).toBe(1);
    expect(m.averageMinor).toBe(3_000);
    expect(m.months.map((x) => x.complete)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it("keeps a closed account from emptying later baselines, and names it", async () => {
    const { t, add } = await setup();
    const old = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Old Visa", kind: "credit_card" })
        .expect(201)
    ).body.id as number;
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: old,
        date: "2026-01-10",
        merchant: "Shop",
        amountMinor: 500,
        direction: "out",
      })
      .expect(201);
    t.sqlite
      .prepare("update accounts set no_longer_shared_at = ? where id = ?")
      .run("2026-03-03T00:00:00Z", old);
    await add("2026-01-05", "Shop", 100);
    await add("2026-07-15", "Shop", 9_000);
    await add("2026-08-15", "Shop", 3_000);
    await add("2026-09-10", "Shop", 3_000);
    const m = spendingMonitor(t.db, {}, "2026-10-20");
    expect(m.baselineMonths).toBe(3);
    expect(m.averageMinor).toBe(5_000);
    expect(m.leftOut).toEqual([{ name: "Old Visa", through: "2026-03-03" }]);
    // The month the account stopped in is still incomplete.
    expect(isMonthComplete("2026-03", [{ from: "2026-01-10", through: "2026-03-03" }])).toBe(false);
  });

  it("lets a new account affect only its first month", () => {
    const old = { from: "2026-01-01", through: null };
    const added = { from: "2026-10-05", through: null };
    expect(isMonthComplete("2026-09", [old, added])).toBe(true);
    expect(isMonthComplete("2026-10", [old, added])).toBe(false);
    expect(isMonthComplete("2026-11", [old, added])).toBe(true);
  });

  it("compares with nothing when no month is complete", async () => {
    const { t, add } = await setup();
    await add("2026-08-15", "Shop", 9_000);
    expect(spendingMonitor(t.db, {}, "2026-09-02")).toMatchObject({
      baselineMonths: 0,
      averageMinor: 0,
      changePercent: null,
    });
  });

  it("knows when a month is fully covered", () => {
    expect(isMonthComplete("2026-09", [{ from: "2026-09-01", through: null }])).toBe(true);
    expect(isMonthComplete("2026-09", [{ from: "2026-09-02", through: null }])).toBe(false);
    expect(isMonthComplete("2026-09", [{ from: "2026-01-01", through: "2026-09-29" }])).toBe(false);
    expect(isMonthComplete("2026-09", [{ from: "2026-01-01", through: "2026-09-30" }])).toBe(true);
    // An account with no history is ignored; with nothing else there is nothing to trust.
    expect(isMonthComplete("2026-09", [{ from: null, through: null }])).toBe(false);
    expect(
      isMonthComplete("2026-09", [
        { from: null, through: null },
        { from: "2026-01-01", through: null },
      ]),
    ).toBe(true);
  });
});
