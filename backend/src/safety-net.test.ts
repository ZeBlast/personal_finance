import { afterEach, describe, expect, it } from "vitest";
import { runwayMonths, safetyNet } from "./services/safety-net.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";

describe("runway months", () => {
  it("is free cash over a month of spending, to one decimal", () => {
    expect(runwayMonths(30_000, 10_000)).toBe(3);
    expect(runwayMonths(25_000, 10_000)).toBe(2.5);
  });
  it("is never below zero", () => {
    expect(runwayMonths(-5, 10_000)).toBe(0);
  });
  it("is null with no spending to cover", () => {
    expect(runwayMonths(5, 0)).toBeNull();
  });
});

describe("the safety net", () => {
  it("answers with zeros on an empty app", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const res = await t.call("get", `/api/safety-net?today=${TODAY}`).expect(200);
    expect(res.body).toMatchObject({
      cashMinor: 0,
      freeCashMinor: 0,
      monthlyMinor: 0,
      months: null,
      basis: "all",
      essentials: [],
    });
  });

  async function seeded() {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const savings = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Savings", kind: "savings" })
        .expect(201)
    ).body.id as number;
    const cat = async (name: string) =>
      (await t.call("post", "/api/categories").send({ name }).expect(201)).body.id as number;
    const rent = await cat("Home rent");
    const fun = await cat("Fun money");
    const add = (
      date: string,
      merchant: string,
      amountMinor: number,
      direction: "in" | "out",
      categoryId?: number,
    ) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId: savings, date, merchant, amountMinor, direction, categoryId })
        .expect(201);
    await add("2026-06-01", "Opening deposit", 1_050_000, "in");
    for (const month of ["07", "08", "09"]) {
      await add(`2026-${month}-03`, "City Apartments", 100_000, "out", rent);
      await add(`2026-${month}-10`, "Arcade", 50_000, "out", fun);
    }
    // 10,500 in − 4,500 out = 6,000 in savings; a goal holds 1,000 of it.
    await t
      .call("post", "/api/goals")
      .send({
        name: "Trip",
        targetMinor: 500_000,
        accountIds: [savings],
        accountAmounts: { [savings]: 100_000 },
      })
      .expect(201);
    return { t, rent, fun };
  }

  it("counts only the essentials, over the three complete months before", async () => {
    const { t, rent } = await seeded();
    await t
      .call("patch", "/api/settings")
      .send({ essentialCategoryIds: [rent] })
      .expect(200);
    const s = safetyNet(t.db, { today: TODAY });
    expect(s).toMatchObject({
      cashMinor: 600_000,
      reservedMinor: 100_000,
      freeCashMinor: 500_000,
      monthlyMinor: 100_000,
      monthsAveraged: 3,
      basis: "essential",
      months: 5,
    });
    expect(s.essentials).toEqual([{ id: rent, name: "Home rent", monthlyMinor: 100_000 }]);
  });

  it("ignores essentials that no longer exist", async () => {
    const { t, rent } = await seeded();
    await t
      .call("patch", "/api/settings")
      .send({ essentialCategoryIds: [rent, 99_999] })
      .expect(200);
    const s = safetyNet(t.db, { today: TODAY });
    expect(s).toMatchObject({ basis: "essential", monthlyMinor: 100_000, months: 5 });
    expect(s.essentials.map((e) => e.id)).toEqual([rent]);
  });

  it("counts all spending when no essentials are chosen", async () => {
    const { t } = await seeded();
    const s = safetyNet(t.db, { today: TODAY });
    // 1,500 a month of rent and fun; 5,000 free.
    expect(s).toMatchObject({ basis: "all", monthlyMinor: 150_000, months: 3.3 });
  });
});
