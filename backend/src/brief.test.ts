import { afterEach, describe, expect, it } from "vitest";
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
});
