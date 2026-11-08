import { afterEach, describe, expect, it } from "vitest";
import { seriesDatesIn } from "./services/plan-dates.js";
import { yearAhead } from "./services/year-ahead.service.js";
import { makeTestApp } from "./test-helpers.js";
import { addDays, addMonths, firstOfMonth, lastOfMonth } from "./utils/dates.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("the year ahead", () => {
  it("is twelve empty months on a new app", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const res = await t.call("get", "/api/year-ahead?today=2026-10-09").expect(200);
    expect(res.body.months).toHaveLength(12);
    expect(res.body.months[0]).toMatchObject({
      month: "2026-10",
      incomeMinor: 0,
      billsMinor: 0,
      capsMinor: 0,
      netMinor: 0,
      short: false,
      items: [],
    });
    expect(res.body.months[11].month).toBe("2027-09");
  });

  it("shows yearly costs and extra paychecks, and leaves dismissed series out", async () => {
    // Recurring series are found from recent history, so this test runs on the real clock.
    const now = new Date().toISOString().slice(0, 10);
    const thisMonth = now.slice(0, 7);
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const checking = (
      await t.call("post", "/api/accounts/manual").send({ name: "Checking", kind: "checking" })
    ).body.id as number;
    const add = (date: string, merchant: string, amountMinor: number, direction: "in" | "out") =>
      t
        .call("post", "/api/transactions")
        .send({ accountId: checking, date, merchant, amountMinor, direction })
        .expect(201);
    const lastPay = addDays(now, -3);
    for (let k = 0; k < 10; k += 1)
      await add(addDays(lastPay, -14 * k), "ACME PAYROLL", 200_000, "in");
    const insured = `${addMonths(thisMonth, -2)}-10`;
    await add(`${addMonths(thisMonth, -14)}-10`, "CAR INSURANCE CO", 60_000, "out");
    await add(insured, "CAR INSURANCE CO", 60_000, "out");
    await add(`${addMonths(thisMonth, -15)}-12`, "OLD GYM ANNUAL", 30_000, "out");
    await add(`${addMonths(thisMonth, -3)}-12`, "OLD GYM ANNUAL", 30_000, "out");

    const recurring = await t.call("get", "/api/insights/recurring").expect(200);
    const gym = (recurring.body.series as Array<{ key: string; merchant: string }>).find(
      (s) => s.merchant === "OLD GYM ANNUAL",
    )!;
    await t
      .call("post", "/api/insights/recurring/dismiss")
      .send({ key: gym.key, merchant: gym.merchant })
      .expect((r) => expect(r.status).toBeLessThan(300));

    const y = yearAhead(t.db, { today: now });
    const items = y.months.flatMap((m) => m.items);
    const renewal = `${addMonths(thisMonth, 10)}-10`;
    expect(items).toContainEqual({
      date: renewal,
      label: "CAR INSURANCE CO",
      amountMinor: -60_000,
      kind: "yearly",
    });
    expect(items.some((i) => i.label === "OLD GYM ANNUAL")).toBe(false);

    for (const m of y.months) {
      const pays = seriesDatesIn(lastPay, "biweekly", firstOfMonth(m.month), lastOfMonth(m.month));
      const extra = m.items.some((i) => i.kind === "extra_paycheck");
      expect(extra).toBe(pays.length === 3);
      expect(m.incomeMinor).toBe(pays.length * 200_000);
    }
  });
});
