import { afterEach, describe, expect, it } from "vitest";
import { reconcileAccount } from "./services/reconcile.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup(kind: string) {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const id = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Acct", kind, openingBalanceMinor: 100_000 })
      .expect(201)
  ).body.id as number;
  const add = (date: string, amountMinor: number, direction: "in" | "out") =>
    t
      .call("post", "/api/transactions")
      .send({ accountId: id, date, merchant: `Shop ${date}`, amountMinor, direction })
      .expect(201);
  return { t, id, add };
}

describe("reconciling with a statement", () => {
  it("works a bank balance back to the statement day and shows the difference", async () => {
    const { t, id, add } = await setup("checking");
    await add("2026-10-05", 2_000, "out");
    await add("2026-10-12", 3_000, "out");
    await add("2026-10-15", 50_000, "in");
    const now = reconcileAccount(t.db, id, "2026-10-10");
    // $1,000 opening, less $20 and $30, plus $500: $1,450 now; before the 12th and 15th: $980.
    expect(now).toMatchObject({ currentMinor: 145_000, sinceCount: 2, ledgerMinor: 98_000 });
    expect(now.differenceMinor).toBeNull();
    expect(now.nearCutoff.map((l) => l.date)).toEqual(["2026-10-12"]);

    expect(reconcileAccount(t.db, id, "2026-10-10", 98_000).differenceMinor).toBe(0);
    // The statement shows $15 less: something the app is missing or has twice.
    const off = await t
      .call("get", `/api/accounts/${id}/reconcile?date=2026-10-10&statementMinor=96500`)
      .expect(200);
    expect(off.body.differenceMinor).toBe(-1_500);
  });

  it("works a card's amount owed back the other way", async () => {
    const { t, id, add } = await setup("credit_card");
    await add("2026-10-12", 3_000, "out");
    const r = reconcileAccount(t.db, id, "2026-10-10");
    // $1,000 owed at the start, $30 more charged after the statement: $1,000 on the statement day.
    expect(r).toMatchObject({ type: "credit", currentMinor: 103_000, ledgerMinor: 100_000 });
  });

  it("refuses an account it cannot reconcile", async () => {
    const { t, id } = await setup("checking");
    await t.call("get", `/api/accounts/${id}/reconcile?date=2026-13-40`).expect(400);
    const asset = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "House", kind: "property", openingBalanceMinor: 1 })
    ).body.id as number | undefined;
    if (asset) await t.call("get", `/api/accounts/${asset}/reconcile?date=2026-10-10`).expect(400);
  });
});
