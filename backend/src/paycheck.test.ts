import { afterEach, describe, expect, it } from "vitest";
import { findPaychecks } from "./services/paycheck.service.js";
import { addDays } from "./utils/dates.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const rows = (source: string, dates: string[], amount = 200_000) =>
  dates.map((date) => ({ date, source, amount, account: "Checking" }));

describe("finding paychecks", () => {
  it("finds pay every two weeks, and projects the rest of the year", () => {
    const dates = Array.from({ length: 10 }, (_, i) => addDays("2026-06-05", i * 14));
    // Last paycheck Oct 9; next Oct 23, then every 14 days: Oct 23, Nov 6, 20, Dec 4, 18.
    const [p] = findPaychecks(rows("ACME Corp", dates), "2026-10-10", 2026);
    expect(p).toMatchObject({
      key: "income:acme corp",
      cadence: "biweekly",
      typicalMinor: 200_000,
      nextExpected: "2026-10-23",
      paydaysLeft: 5,
      receivedThisYearMinor: 2_000_000,
      projectedYearMinor: 3_000_000,
      active: true,
    });
  });

  it("finds pay twice a month (the 1st and 15th) and monthly pay", () => {
    const semi: string[] = [];
    for (let m = 4; m <= 9; m++) {
      const mm = String(m).padStart(2, "0");
      semi.push(`2026-${mm}-01`, `2026-${mm}-15`);
    }
    const monthly = ["2026-05-28", "2026-06-28", "2026-07-28", "2026-08-28", "2026-09-28"];
    const found = findPaychecks(
      [...rows("State Agency", semi, 150_000), ...rows("Side Gig LLC", monthly, 40_000)],
      "2026-09-20",
      2026,
    );
    expect(found.map((p) => [p.source, p.cadence])).toEqual([
      ["State Agency", "semimonthly"],
      ["Side Gig LLC", "monthly"],
    ]);
  });

  it("leaves out irregular income, and pay that stopped", () => {
    const irregular = ["2026-01-03", "2026-02-20", "2026-02-27", "2026-05-11", "2026-08-30"];
    const stopped = Array.from({ length: 6 }, (_, i) => addDays("2026-01-02", i * 14));
    const found = findPaychecks(
      [...rows("Odd jobs", irregular), ...rows("Old Job Inc", stopped)],
      "2026-10-10",
      2026,
    );
    expect(found.find((p) => p.source === "Odd jobs")).toBeUndefined();
    expect(found.find((p) => p.source === "Old Job Inc")).toMatchObject({
      active: false,
      paydaysLeft: 0,
      projectedYearMinor: 1_200_000,
    });
  });
});

describe("paychecks from the data", () => {
  it("shows on /paychecks and gives the Taxes page a projection", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const account = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 8; i >= 1; i--) {
      const res = await t
        .call("post", "/api/transactions")
        .send({
          accountId: account,
          date: addDays(today, -i * 14),
          merchant: "ACME PAYROLL",
          amountMinor: 250_000,
          direction: "in",
        })
        .expect(201);
      await t
        .call("patch", `/api/transactions/${res.body.id}`)
        .send({ sender: "ACME Corp" })
        .expect(200);
    }
    const pay = (await t.call("get", "/api/paychecks").expect(200)).body as Array<{
      source: string;
      cadence: string;
      typicalMinor: number;
    }>;
    expect(pay).toEqual([
      expect.objectContaining({ source: "ACME Corp", cadence: "biweekly", typicalMinor: 250_000 }),
    ]);
    // The Taxes page counts this year's paychecks only; early in a year there are none yet.
    if (today.slice(5) < "05-01") return;
    const year = Number(today.slice(0, 4));
    const taxes = (await t.call("get", `/api/taxes/${year}`).expect(200)).body;
    const source = taxes.sources.find((s: { key: string }) => s.key === "income:acme corp");
    expect(source.paycheck).toMatchObject({ cadence: "biweekly", typicalMinor: 250_000 });
    expect(source.wages).toBe(true);
  });
});
