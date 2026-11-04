import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts } from "../../drizzle/schema.js";
import { dailyBrief } from "./services/brief.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";

describe("the daily brief", () => {
  it("is the lowest cash before payday, less goals' money and the buffer", async () => {
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
    await t
      .call("post", "/api/goals")
      .send({
        name: "Trip",
        targetMinor: 500_000,
        accountIds: [checking],
        accountAmounts: { [checking]: 100_000 },
      })
      .expect(201);

    const b = dailyBrief(t.db, { today: TODAY, bufferMinor: 50_000 });
    expect(b.cashMinor).toBe(600_000);
    expect(b.nextIncome).toMatchObject({ date: "2026-10-20", label: "ACME PAYROLL" });
    expect(b.until).toBe("2026-10-19");
    expect(b.obligations).toEqual([
      { label: "City Apartments", date: "2026-10-12", amountMinor: -150_000, source: "recurring" },
    ]);
    expect(b.lowest).toEqual({ date: "2026-10-12", balanceMinor: 450_000 });
    expect(b.reservedFor).toEqual([{ accountName: "Checking", amountMinor: 100_000 }]);
    // 450,000 lowest - 100,000 for the trip - 50,000 buffer.
    expect(b.safeToSpendMinor).toBe(300_000);
    expect(b.shortMinor).toBe(0);
    expect(b.perDayMinor).toBe(Math.floor(300_000 / 11));

    const tight = dailyBrief(t.db, { today: TODAY, bufferMinor: 400_000 });
    expect(tight).toMatchObject({ safeToSpendMinor: 0, shortMinor: 50_000 });

    const res = await t.call("get", `/api/brief?today=${TODAY}&bufferMinor=50000`).expect(200);
    expect(res.body.safeToSpendMinor).toBe(300_000);
  });

  async function withPaydays() {
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
      await add(`2026-${month}-15`, "SIDE GIG", 20_000, "in");
    }
    return t;
  }

  it("ends the window at the income you chose", async () => {
    const t = await withPaydays();
    expect(dailyBrief(t.db, { today: TODAY }).nextIncome).toMatchObject({
      label: "SIDE GIG",
      chosen: false,
    });
    const acme = dailyBrief(t.db, { today: TODAY }).incomeOptions.find(
      (o) => o.label === "ACME PAYROLL",
    )!;
    await t.call("patch", "/api/settings").send({ briefIncomeKey: acme.key }).expect(200);
    expect(dailyBrief(t.db, { today: TODAY })).toMatchObject({
      until: "2026-10-19",
      nextIncome: { chosen: true },
    });
    await t.call("patch", "/api/settings").send({ briefIncomeKey: "recurring:gone" }).expect(200);
    expect(dailyBrief(t.db, { today: TODAY })).toMatchObject({
      incomeChoiceMissing: true,
      nextIncome: { label: "SIDE GIG" },
    });
  });

  it("names bank accounts left out for having no balance", async () => {
    const t = await withPaydays();
    const savings = (
      await t.call("post", "/api/accounts/manual").send({ name: "Savings", kind: "savings" })
    ).body.id as number;
    t.db.update(accounts).set({ currentBalanceMinor: null }).where(eq(accounts.id, savings)).run();
    expect(dailyBrief(t.db, { today: TODAY }).missingAccounts).toEqual(["Savings"]);
  });

  it("adds up the cap hold-back that falls in the window", async () => {
    const t = await withPaydays();
    expect(dailyBrief(t.db, { today: TODAY }).capHoldBack).toEqual({
      included: false,
      inWindowMinor: 0,
    });
    const dining = (await t.call("post", "/api/categories").send({ name: "Dining" }).expect(201))
      .body.id as number;
    await t
      .call("post", "/api/budgets")
      .send({ categoryId: dining, month: "2026-10", amountMinor: 30_000 })
      .expect(201);
    await t.call("patch", "/api/settings").send({ forecastHoldCaps: true }).expect(200);
    const held = dailyBrief(t.db, { today: TODAY }).capHoldBack;
    expect(held.included).toBe(true);
    // Only the days up to payday (the 14th) count, so less than the whole cap.
    expect(held.inWindowMinor).toBeGreaterThan(0);
    expect(held.inWindowMinor).toBeLessThan(30_000);
  });
});
