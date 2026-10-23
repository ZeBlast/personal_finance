import { afterEach, describe, expect, it } from "vitest";
import { estimateMinimum, simulatePayoff } from "./services/debt.service.js";
import { cashForecast } from "./services/forecast.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const card = { id: 1, name: "Card", balanceMinor: 300_000, aprBps: 2400, minimumMinor: 10_000 };
const loan = { id: 2, name: "Loan", balanceMinor: 100_000, aprBps: 600, minimumMinor: 10_000 };

describe("paying off debt", () => {
  it("charges a month's interest, then pays", () => {
    // $1,000 at 12%: $10 of interest, then the $1,010 is paid at once.
    const plan = simulatePayoff([{ ...loan, aprBps: 1200, minimumMinor: 200_000 }], 0, "avalanche");
    expect(plan).toMatchObject({ months: 1, totalInterestMinor: 1_000 });
    expect(plan.balances).toEqual([100_000, 0]);
  });

  it("pays less interest highest rate first, and gets the small one done first by balance", () => {
    const avalanche = simulatePayoff([card, loan], 20_000, "avalanche");
    const snowball = simulatePayoff([card, loan], 20_000, "snowball");
    expect(avalanche.totalInterestMinor).toBeLessThan(snowball.totalInterestMinor);
    const month = (plan: typeof avalanche, name: string) =>
      plan.debts.find((d) => d.name === name)!.payoffMonth!;
    // By balance the extra clears the small loan first; by rate it goes to the card, and the
    // loan is left to its minimum. (The card is last either way: the monthly total is the same.)
    expect(month(snowball, "Loan")).toBeLessThan(month(avalanche, "Loan"));
    expect(avalanche.monthlyPaymentMinor).toBe(40_000);
    // Paying extra is quicker and cheaper than the minimums alone.
    const minimums = simulatePayoff([card, loan], 0, "avalanche");
    expect(avalanche.months!).toBeLessThan(minimums.months!);
    expect(avalanche.totalInterestMinor).toBeLessThan(minimums.totalInterestMinor);
  });

  it("says when the payments never catch up with the interest", () => {
    const plan = simulatePayoff([{ ...card, minimumMinor: 5_000 }], 0, "avalanche");
    expect(plan.months).toBeNull();
    expect(plan.debts[0]!.payoffMonth).toBeNull();
  });

  it("estimates a card's minimum as interest plus 1%, at least $25", () => {
    expect(estimateMinimum(300_000, 2400)).toBe(6_000 + 3_000);
    expect(estimateMinimum(50_000, 0)).toBe(2_500);
    expect(estimateMinimum(1_000, 2400)).toBe(1_000);
  });

  it("counts the plan's extra in the cash forecast when asked, until the debts are paid", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Checking", kind: "checking", openingBalanceMinor: 500_000 })
      .expect(201);
    const card = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Visa", kind: "credit_card", openingBalanceMinor: 30_000 })
        .expect(201)
    ).body.id as number;
    await t.call("put", `/api/debt/${card}`).send({ aprBps: 0, minimumMinor: 0 }).expect(200);
    const today = "2026-10-15";
    const planned = () =>
      cashForecast(t.db, { today, days: 180 }).days.flatMap((d) =>
        d.events.filter((e) => e.source === "debt_plan").map((e) => [d.date, e.amountMinor]),
      );
    expect(planned()).toEqual([]);
    await t.call("patch", "/api/settings").send({ debtExtraInForecastMinor: 10_000 }).expect(200);
    // $300 owed at no interest, $100 a month: three payments, then the plan is done.
    expect(planned()).toEqual([
      ["2026-11-01", -10_000],
      ["2026-12-01", -10_000],
      ["2027-01-01", -10_000],
    ]);
  });

  it("plans only the debts whose rate is entered", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const make = async (name: string, kind: string, openingBalanceMinor: number) =>
      (
        await t
          .call("post", "/api/accounts/manual")
          .send({ name, kind, openingBalanceMinor })
          .expect(201)
      ).body.id as number;
    const visa = await make("Visa", "credit_card", 300_000);
    await make("Store card", "credit_card", 50_000);
    const checking = await make("Checking", "checking", 100_000);

    await t
      .call("put", `/api/debt/${visa}`)
      .send({ aprBps: 2400, minimumMinor: 10_000 })
      .expect(200);
    await t.call("put", `/api/debt/${checking}`).send({ aprBps: 100 }).expect(400);
    const res = await t.call("get", "/api/debt?extraMinor=20000").expect(200);
    expect(res.body.debts.map((d: { name: string }) => d.name).sort()).toEqual([
      "Store card",
      "Visa",
    ]);
    expect(res.body.missingRate).toEqual(["Store card"]);
    expect(res.body.plan.debts.map((d: { name: string }) => d.name)).toEqual(["Visa"]);
    expect(res.body.plan.monthlyPaymentMinor).toBe(30_000);
    expect(res.body.minimumsOnly.months).toBeGreaterThan(res.body.plan.months);
  });
});
