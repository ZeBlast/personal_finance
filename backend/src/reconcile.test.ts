import { afterEach, describe, expect, it } from "vitest";
import { transactions } from "../../drizzle/schema.js";
import { reconcileAccount } from "./services/reconcile.service.js";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";

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

  it("saves each check as matched or unresolved, and the account shows the latest", async () => {
    const { t, id, add } = await setup("checking");
    await add("2026-10-05", 2_000, "out");
    await t
      .call("post", `/api/accounts/${id}/reconciliations`)
      .send({ statementDate: "2026-10-10", statementBalanceMinor: 98_000 })
      .expect(201);
    const off = await t
      .call("post", `/api/accounts/${id}/reconciliations`)
      .send({ statementDate: "2026-10-20", statementBalanceMinor: 90_000, note: "bank fee?" })
      .expect(201);
    expect(off.body).toMatchObject({
      status: "unresolved",
      differenceMinor: -8_000,
      note: "bank fee?",
    });
    const list = (await t.call("get", `/api/accounts/${id}/reconciliations`).expect(200)).body;
    expect(list.map((r: { statementDate: string }) => r.statementDate)).toEqual([
      "2026-10-20",
      "2026-10-10",
    ]);
    expect(list[1].status).toBe("matched");
    const accounts = (await t.call("get", "/api/accounts?includeHidden=1")).body;
    const acct = accounts.find((a: { id: number }) => a.id === id);
    expect(acct.lastReconciled).toEqual({ statementDate: "2026-10-20", status: "unresolved" });

    // A note can be changed or cleared, and a check removed.
    const patched = await t
      .call("patch", `/api/reconciliations/${off.body.id}`)
      .send({ note: null })
      .expect(200);
    expect(patched.body.note).toBeNull();
    await t
      .call("patch", `/api/reconciliations/${off.body.id}`)
      .send({ note: "x".repeat(501) })
      .expect(400);
    await t.call("delete", `/api/reconciliations/${off.body.id}`).expect(204);
    await t.call("delete", `/api/reconciliations/${off.body.id}`).expect(404);
  });

  it("lists likely causes: a doubled charge and a quiet stretch", async () => {
    const { t, id } = await setup("checking");
    const put = (date: string, name: string, amountMinor: number) =>
      t.db
        .insert(transactions)
        .values({
          accountId: id,
          date,
          name,
          merchantName: name,
          amountMinor,
          source: "plaid",
          createdAt: "2026-11-03T00:00:00Z",
          updatedAt: "2026-11-03T00:00:00Z",
        })
        .run();
    put("2026-09-25", "Early", 500);
    for (let day = 1; day <= 11; day++)
      put(`2026-10-${String(day).padStart(2, "0")}`, `Shop ${day}`, 100 + day);
    put("2026-10-11", "Coffee", 450);
    put("2026-10-11", "Coffee", 450);
    put("2026-10-26", "Late", 700);
    const r = reconcileAccount(t.db, id, "2026-10-31", null, "2026-11-03");
    expect(r.periodFrom).toBe("2026-10-01");
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]!.map((l) => l.merchant)).toEqual(["Coffee", "Coffee"]);
    expect(r.gaps).toContainEqual({ from: "2026-10-12", to: "2026-10-25", reason: "quiet" });
  });

  it("starts the period the day after the last saved check, and refuses a future statement", async () => {
    const { t, id } = await setup("checking");
    await t
      .call("post", `/api/accounts/${id}/reconciliations`)
      .send({ statementDate: "2026-10-10", statementBalanceMinor: 100_000 })
      .expect(201);
    expect(reconcileAccount(t.db, id, "2026-10-31", null, "2026-11-03").periodFrom).toBe(
      "2026-10-11",
    );
    // Too long ago to follow on from: back to a month before the statement.
    expect(reconcileAccount(t.db, id, "2027-01-31", null, "2027-02-03").periodFrom).toBe(
      "2027-01-01",
    );
    expect(() => reconcileAccount(t.db, id, "2026-11-04", null, "2026-11-03")).toThrow(
      /after today/,
    );
    await t
      .call("post", `/api/accounts/${id}/reconciliations`)
      .send({ statementDate: "2999-01-01", statementBalanceMinor: 100_000 })
      .expect(400);
  });

  it("flags days the connection has not synced", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    const acct = bank.item.accounts.find((a) => a["type"] === "depository")!;
    const id = acct["id"] as number;
    h.sqlite
      .prepare("update plaid_items set last_successful_sync_at = ? where id = ?")
      .run("2026-10-20T08:00:00Z", bank.item.id);
    h.sqlite.prepare("update accounts set current_balance_minor = 100000 where id = ?").run(id);
    const r = reconcileAccount(h.db, id, "2026-10-31", null, "2026-11-03");
    expect(r.gaps).toContainEqual({ from: "2026-10-21", to: "2026-10-31", reason: "not_synced" });
  });
});
