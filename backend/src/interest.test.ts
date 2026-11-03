import { afterEach, describe, expect, it } from "vitest";
import { cashForecast } from "./services/forecast.service.js";
import { accountInterest, monthlyInterest, monthlyRate } from "./services/interest.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";

async function setup() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = async (name: string, kind: string, openingBalanceMinor = 0) =>
    (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name, kind, openingBalanceMinor })
        .expect(201)
    ).body.id as number;
  const add = async (accountId: number, date: string, merchant: string, amountMinor: number) =>
    t
      .call("post", "/api/transactions")
      .send({ accountId, date, merchant, amountMinor, direction: "in" })
      .expect(201);
  const interestEvents = () =>
    cashForecast(t.db, { today: TODAY, days: 90 }).days.flatMap((d) =>
      d.events
        .filter((e) => /interest/i.test(e.label))
        .map((e) => [d.date, e.label, e.amountMinor, e.source]),
    );
  return { t, account, add, interestEvents };
}

describe("interest from an APY", () => {
  it("uses the compounded monthly rate, each month earning on the last", () => {
    // 12 months at the monthly rate come back to the APY.
    expect(Math.pow(1 + monthlyRate(500), 12)).toBeCloseTo(1.05, 10);
    const paid = monthlyInterest(1_000_000, 500, 12);
    expect(paid[0]).toBe(4074);
    expect(paid.reduce((n, x) => n + x, 0)).toBeCloseTo(50_000, -1);
    expect(paid[11]!).toBeGreaterThan(paid[0]!);
    expect(monthlyInterest(-500, 500, 2)).toEqual([0, 0]);
  });

  it("is set on a bank account only, and estimates what it earns", async () => {
    const s = await setup();
    const savings = await s.account("Savings", "savings", 1_000_000);
    const card = await s.account("Visa", "credit_card");
    await s.t.call("put", `/api/accounts/${card}/interest`).send({ apyBps: 400 }).expect(400);
    await s.t.call("put", `/api/accounts/${savings}/interest`).send({ apyBps: 9000 }).expect(400);
    const set = (
      await s.t.call("put", `/api/accounts/${savings}/interest`).send({ apyBps: 500 }).expect(200)
    ).body;
    expect(set).toMatchObject({ apyBps: 500, balanceMinor: 1_000_000, monthlyMinor: 4074 });
    await s.t.call("delete", `/api/accounts/${savings}/interest`).expect(204);
    expect(accountInterest(s.t.db, savings, TODAY)).toMatchObject({
      apyBps: null,
      monthlyMinor: null,
    });
  });

  it("adds up the interest the account received", async () => {
    const s = await setup();
    const savings = await s.account("Savings", "savings", 1_000_000);
    await s.add(savings, "2025-11-30", "Interest Paid", 3000);
    await s.add(savings, "2026-01-31", "INTEREST PAYMENT", 4000);
    await s.add(savings, "2026-09-30", "Interest Paid", 4100);
    await s.add(savings, "2026-09-15", "Paycheck", 200_000);
    expect(accountInterest(s.t.db, savings, TODAY)).toMatchObject({
      earnedThisYearMinor: 8100,
      earnedLast12MonthsMinor: 11_100,
    });
  });

  it("counts interest in the cash forecast at each month's end, in place of found recurring interest", async () => {
    const s = await setup();
    const savings = await s.account("Savings", "savings", 1_000_000);
    for (const m of ["06", "07", "08", "09"])
      await s.add(savings, `2026-${m}-28`, "Interest Paid", 4000);
    // Before the APY is set, the interest found in the history carries on.
    expect(s.interestEvents().map((e) => e[3])).toEqual(["recurring", "recurring", "recurring"]);
    await s.t.call("put", `/api/accounts/${savings}/interest`).send({ apyBps: 500 }).expect(200);
    const balance = 1_000_000 + 16_000;
    const [oct, nov, dec] = monthlyInterest(balance, 500, 3);
    expect(s.interestEvents()).toEqual([
      ["2026-10-31", "Savings interest", oct, "interest"],
      ["2026-11-30", "Savings interest", nov, "interest"],
      ["2026-12-31", "Savings interest", dec, "interest"],
    ]);
  });
});
