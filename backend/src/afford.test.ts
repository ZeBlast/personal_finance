import { afterEach, describe, expect, it } from "vitest";
import {
  affordCheck,
  affordOn,
  earliestAffordable,
  suffixLows,
} from "./services/afford.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const DAYS = [100, 80, 120, 60, 200].map((b, i) => ({
  date: `2026-10-0${i + 1}`,
  balanceMinor: b * 100,
}));

describe("affordability maths", () => {
  it("knows the lowest balance from each day on", () => {
    expect(suffixLows(DAYS)).toEqual([6_000, 6_000, 6_000, 6_000, 20_000]);
    expect(suffixLows([])).toEqual([]);
  });

  it("lowers every day from the purchase on", () => {
    expect(affordOn(DAYS, 5_000, 0, "2026-10-01")).toEqual({
      ok: true,
      lowest: { date: "2026-10-04", balanceMinor: 1_000 },
    });
    expect(affordOn(DAYS, 7_000, 0, "2026-10-01").ok).toBe(false);
    // On the last day only that day is lowered.
    expect(affordOn(DAYS, 7_000, 0, "2026-10-05")).toEqual({
      ok: true,
      lowest: { date: "2026-10-05", balanceMinor: 13_000 },
    });
  });

  it("keeps a floor of goals' money and a buffer", () => {
    expect(affordOn(DAYS, 5_000, 2_000, "2026-10-01").ok).toBe(false);
  });

  it("finds the earliest day that works, or none", () => {
    expect(earliestAffordable(DAYS, 7_000, 0)).toBe("2026-10-05");
    expect(earliestAffordable(DAYS, 5_000, 0)).toBe("2026-10-01");
    expect(earliestAffordable(DAYS, 50_000, 0)).toBeNull();
  });
});

describe("can I afford it", () => {
  const TODAY = "2026-10-09";

  it("offers save-for-it plans when no day works, even on an empty app", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const res = await t.call("get", `/api/afford?amountMinor=120000&today=${TODAY}`).expect(200);
    expect(res.body).toMatchObject({
      amountMinor: 120_000,
      floorMinor: 0,
      asked: null,
      earliest: null,
      alreadyShort: false,
      horizonEnd: "2027-01-07",
    });
    expect(res.body.plans).toEqual([
      { months: 3, perMonthMinor: 40_000, by: "2027-01-09" },
      { months: 6, perMonthMinor: 20_000, by: "2027-04-09" },
      { months: 12, perMonthMinor: 10_000, by: "2027-10-09" },
    ]);
  });

  it("refuses a day before today or past the forecast", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t.call("get", `/api/afford?amountMinor=100&today=${TODAY}&date=2026-10-08`).expect(400);
    await t.call("get", `/api/afford?amountMinor=100&today=${TODAY}&date=2027-06-01`).expect(400);
  });

  it("answers for the day asked and the earliest day, above goals and a buffer", async () => {
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
    for (const month of ["06", "07", "08", "09"]) {
      await add(`2026-${month}-20`, "ACME PAYROLL", 300_000, "in");
      await add(`2026-${month}-12`, "City Apartments", 150_000, "out");
    }
    // Cash now 6,000; rent takes 1,500 on the 12th, pay adds 3,000 on the 20th, each month.
    const a = affordCheck(t.db, {
      amountMinor: 400_000,
      bufferMinor: 50_000,
      date: "2026-10-10",
      today: TODAY,
    });
    expect(a.floorMinor).toBe(50_000);
    expect(a.asked).toMatchObject({
      date: "2026-10-10",
      ok: true,
      lowest: { date: "2026-10-12", balanceMinor: 50_000 },
      marginMinor: 0,
    });
    expect(a.earliest?.date).toBe(TODAY);

    const big = affordCheck(t.db, { amountMinor: 500_000, date: "2026-10-10", today: TODAY });
    expect(big.asked?.ok).toBe(false);
    // From the 20th the cash never falls below 6,000 (the 12th of November).
    expect(big.earliest?.date).toBe("2026-10-20");
  });
});
