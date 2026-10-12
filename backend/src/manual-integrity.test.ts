import { afterEach, describe, expect, it } from "vitest";
import {
  createManualBankAccount,
  createManualTransaction,
  deleteManualTransaction,
  repairManualBalanceHistories,
  updateAnyTransaction,
} from "./services/manual-transaction.service.js";
import { netWorthHistory } from "./services/networth-history.service.js";
import { netWorthSeries } from "./services/networth-series.service.js";
import { getTransaction } from "./services/transaction.service.js";
import { linkTransferToAccount, unlinkTransfer } from "./services/transfer-link.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function setup(kind: "cash" | "credit_card" = "cash") {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const accountId = createManualBankAccount(
    t.db,
    {
      name: "Manual account",
      kind,
      openingBalanceMinor: 10000,
    },
    "2026-09-01T12:00:00Z",
  );
  const add = (date: string, amountMinor: number, recordedDay = date) =>
    createManualTransaction(
      t.db,
      { accountId, date, amountMinor, direction: "out", merchant: "Coffee" },
      `${recordedDay}T12:00:00Z`,
    );
  const balance = () =>
    (
      t.sqlite
        .prepare("select current_balance_minor as balance from accounts where id = ?")
        .get(accountId) as { balance: number }
    ).balance;
  const history = () =>
    netWorthSeries(t.db, {
      granularity: "day",
      from: "2026-09-01",
      to: "2026-09-10",
      today: "2026-09-10",
    }).points;
  return { ...t, accountId, add, balance, history };
}

describe("manual transaction integrity", () => {
  it("rolls back a rejected category edit, including balances and observations", async () => {
    const t = setup();
    const transaction = t.add("2026-09-02", 1000);
    const before = t.sqlite.prepare("select * from balance_snapshots").all();
    await t
      .call("patch", `/api/transactions/${transaction.id}`)
      .send({ amountMinor: 2000, merchant: "Changed", categoryId: 999999 })
      .expect(400);
    expect(getTransaction(t.db, transaction.id)).toMatchObject({
      amountMinor: 1000,
      merchant: "Coffee",
    });
    expect(t.balance()).toBe(9000);
    expect(t.sqlite.prepare("select * from balance_snapshots").all()).toEqual(before);
  });

  it("rolls back metadata when changing a linked transfer flag is rejected", async () => {
    const t = setup();
    const otherAccount = createManualBankAccount(
      t.db,
      { name: "Savings", kind: "savings" },
      "2026-09-01T12:00:00Z",
    );
    const transaction = t.add("2026-09-02", 3000);
    linkTransferToAccount(t.db, transaction.id, otherAccount);
    await t
      .call("patch", `/api/transactions/${transaction.id}`)
      .send({ notes: "Should not save", merchant: "Changed", isTransfer: false })
      .expect(409);
    expect(getTransaction(t.db, transaction.id)).toMatchObject({
      notes: null,
      merchant: "Coffee",
      isTransfer: true,
    });
  });

  it.each(["cash", "credit_card"] as const)(
    "rebuilds %s history after backdated entries, edits and deletion",
    (kind) => {
      const t = setup(kind);
      t.add("2026-09-05", 1000);
      const late = t.add("2026-09-02", 1000, "2026-09-10");
      const sign = kind === "cash" ? -1 : 1;
      const values = () =>
        t.history().map((p) => (kind === "cash" ? p.assetsMinor : p.liabilitiesMinor));
      expect(values()).toEqual([
        10000,
        ...Array(3).fill(10000 + sign * 1000),
        ...Array(6).fill(10000 + sign * 2000),
      ]);
      const recorded = netWorthHistory(t.db, {}).points.find((p) => p.date === "2026-09-05")!;
      expect(kind === "cash" ? recorded.assetsMinor : recorded.liabilitiesMinor).toBe(
        10000 + sign * 2000,
      );
      updateAnyTransaction(
        t.db,
        late.id,
        { amountMinor: 2000, date: "2026-09-03" },
        "2026-09-10T13:00:00Z",
      );
      expect(values()).toEqual([
        10000,
        10000,
        10000 + sign * 2000,
        10000 + sign * 2000,
        ...Array(6).fill(10000 + sign * 3000),
      ]);
      deleteManualTransaction(t.db, late.id, "2026-09-10T14:00:00Z");
      expect(values()).toEqual([...Array(4).fill(10000), ...Array(6).fill(10000 + sign * 1000)]);
    },
  );

  it("rebuilds history on both accounts when a transaction is moved", () => {
    const t = setup();
    const target = createManualBankAccount(
      t.db,
      { name: "Other", kind: "cash", openingBalanceMinor: 5000 },
      "2026-09-01T12:00:00Z",
    );
    const transaction = t.add("2026-09-02", 1000);
    updateAnyTransaction(t.db, transaction.id, { accountId: target }, "2026-09-10T12:00:00Z");
    const snapshots = t.sqlite
      .prepare(
        "select account_id as accountId, current_balance_minor as balance from balance_snapshots where observed_at = ? order by account_id",
      )
      .all("2026-09-01T12:00:00Z");
    expect(snapshots).toEqual([
      { accountId: t.accountId, balance: 10000 },
      { accountId: target, balance: 5000 },
    ]);
    expect(t.balance()).toBe(10000);
    expect(t.history().at(-1)!.assetsMinor).toBe(14000);
  });

  it("repairs stale observations from previous versions and is idempotent", () => {
    const t = setup();
    t.add("2026-09-05", 1000);
    t.add("2026-09-02", 1000, "2026-09-10");
    t.sqlite
      .prepare("update balance_snapshots set current_balance_minor = 9000 where observed_at = ?")
      .run("2026-09-05T12:00:00Z");
    repairManualBalanceHistories(t.db);
    expect(t.history().find((p) => p.date === "2026-09-05")!.assetsMinor).toBe(8000);
    const before = t.sqlite.prepare("select * from balance_snapshots").all();
    repairManualBalanceHistories(t.db);
    expect(t.sqlite.prepare("select * from balance_snapshots").all()).toEqual(before);
  });

  it("requires unlinking before changing either side of a manually linked transfer", async () => {
    const t = setup();
    const target = createManualBankAccount(
      t.db,
      { name: "Savings", kind: "savings" },
      "2026-09-01T12:00:00Z",
    );
    const transaction = t.add("2026-09-02", 3000);
    const linked = linkTransferToAccount(t.db, transaction.id, target, "2026-09-02T13:00:00Z");
    const partnerId = linked.transferWith!.id;
    for (const [id, patch] of [
      [transaction.id, { amountMinor: 4000 }],
      [transaction.id, { direction: "in" }],
      [transaction.id, { date: "2026-09-03" }],
      [transaction.id, { accountId: target }],
      [transaction.id, { pending: true }],
      [partnerId, { amountMinor: 4000 }],
    ] as const) {
      const res = await t.call("patch", `/api/transactions/${id}`).send(patch).expect(409);
      expect(res.body.error).toBe("linked_transfer");
    }
    expect(t.balance()).toBe(7000);
    expect(getTransaction(t.db, partnerId)).toMatchObject({
      amountMinor: -3000,
      transferWith: { id: transaction.id },
    });
    // The edit form submits unchanged financial fields along with metadata; those remain allowed.
    await t
      .call("patch", `/api/transactions/${transaction.id}`)
      .send({
        accountId: t.accountId,
        date: "2026-09-02",
        amountMinor: 3000,
        direction: "out",
        pending: false,
        notes: "Allowed",
      })
      .expect(200);
    expect(getTransaction(t.db, transaction.id)).toMatchObject({
      notes: "Allowed",
      transferWith: { id: partnerId },
    });
    unlinkTransfer(t.db, transaction.id, "2026-09-10T12:00:00Z");
    await t
      .call("patch", `/api/transactions/${transaction.id}`)
      .send({ amountMinor: 4000 })
      .expect(200);
    expect(t.balance()).toBe(6000);
  });
});
