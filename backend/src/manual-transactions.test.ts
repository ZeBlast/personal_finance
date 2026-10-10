import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "./db/client.js";
import {
  linkDemoBank,
  makeSyncHarness,
  makeTestApp,
  MIGRATIONS,
  truncatedMigrations,
  TEST_DB_KEY,
} from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}
type T = ReturnType<typeof app>;

async function account(t: T, body: Record<string, unknown> = {}) {
  const res = await t
    .call("post", "/api/accounts/manual")
    .send({ name: "Wallet", kind: "cash", ...body })
    .expect(201);
  return res.body.id as number;
}
const balanceOf = async (t: T, id: number) =>
  (
    (await t.call("get", "/api/accounts").expect(200)).body as Array<{
      id: number;
      currentBalanceMinor: number;
    }>
  ).find((a) => a.id === id)!.currentBalanceMinor;
const add = (t: T, body: Record<string, unknown>) => t.call("post", "/api/transactions").send(body);
const base = (accountId: number, over: Record<string, unknown> = {}) => ({
  accountId,
  date: "2026-09-10",
  merchant: "Corner Cafe",
  amountMinor: 1250,
  direction: "out",
  ...over,
});

describe("accounts kept by hand", () => {
  it("creates a cash account whose balance is its opening balance", async () => {
    const t = app();
    const id = await account(t, { openingBalanceMinor: 50000 });
    const list = (await t.call("get", "/api/accounts").expect(200)).body;
    expect(list.find((a: { id: number }) => a.id === id)).toMatchObject({
      name: "Wallet",
      type: "depository",
      subtype: "cash",
      isManual: true,
      source: "manual",
      currentBalanceMinor: 50000,
    });
    const tx = (await t.call("get", `/api/transactions?accountId=${id}`).expect(200)).body.items;
    expect(tx).toHaveLength(1);
    // Where the account starts is not income or spending.
    expect(tx[0]).toMatchObject({
      merchant: "Opening balance",
      isTransfer: true,
      source: "manual",
      amountMinor: -50000,
    });
  });

  it("starts at zero with no opening balance, and allows an overdrawn start", async () => {
    const t = app();
    const empty = await account(t, { name: "Empty" });
    expect(await balanceOf(t, empty)).toBe(0);
    expect(
      (await t.call("get", `/api/transactions?accountId=${empty}`).expect(200)).body.total,
    ).toBe(0);
    const overdrawn = await account(t, {
      name: "Overdrawn",
      kind: "checking",
      openingBalanceMinor: -2500,
    });
    expect(await balanceOf(t, overdrawn)).toBe(-2500);
  });

  it("makes checking, savings, and card accounts, and a card can have a limit", async () => {
    const t = app();
    const card = await account(t, {
      name: "Visa",
      kind: "credit_card",
      openingBalanceMinor: 20000,
      creditLimitMinor: 500000,
    });
    const list = (await t.call("get", "/api/accounts").expect(200)).body;
    expect(list.find((a: { id: number }) => a.id === card)).toMatchObject({
      type: "credit",
      subtype: "credit card",
      currentBalanceMinor: 20000,
      creditLimitMinor: 500000,
    });
    expect(
      (await t.call("get", `/api/accounts/${card}/credit-limits`).expect(200)).body.current
        .limitMinor,
    ).toBe(500000);
    const savings = await account(t, { name: "Savings", kind: "savings" });
    expect(list.length).toBe(1);
    expect(
      (
        (await t.call("get", "/api/accounts").expect(200)).body as Array<{
          id: number;
          subtype: string;
        }>
      ).find((a) => a.id === savings)!.subtype,
    ).toBe("savings");
  });

  it("rejects bad input", async () => {
    const t = app();
    await t.call("post", "/api/accounts/manual").send({ name: " ", kind: "cash" }).expect(400);
    await t.call("post", "/api/accounts/manual").send({ name: "x", kind: "bitcoin" }).expect(400);
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "x", kind: "cash", openingBalanceMinor: 1.5 })
      .expect(400);
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "x", kind: "cash", creditLimitMinor: 100 })
      .expect(400);
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "x", kind: "cash", extra: 1 })
      .expect(400);
  });

  it("deletes the account with its transactions, and refuses connected accounts", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    const cash = await account(h as unknown as T, { openingBalanceMinor: 1000 });
    await add(h as unknown as T, base(cash)).expect(201);
    await h.call("delete", `/api/accounts/manual/${cash}`).expect(204);
    expect(
      h.sqlite.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?").get(cash),
    ).toEqual({ n: 0 });
    await h.call("delete", `/api/accounts/manual/${cash}`).expect(404);
    const connected = (bank.item.accounts[0] as { id: number }).id;
    await h.call("delete", `/api/accounts/manual/${connected}`).expect(409);
  });
});

describe("transactions entered by hand", () => {
  it("adds a cash purchase, keeps the balance in step, and counts it as spending", async () => {
    const t = app();
    const id = await account(t, { openingBalanceMinor: 50000 });
    const groceries = (await t.call("post", "/api/categories").send({ name: "Dining" }).expect(201))
      .body.id;
    const res = await add(
      t,
      base(id, { categoryId: groceries, notes: "lunch", recipient: "Cafe owner" }),
    ).expect(201);
    expect(res.body).toMatchObject({
      accountId: id,
      date: "2026-09-10",
      merchant: "Corner Cafe",
      name: "Corner Cafe",
      amountMinor: 1250,
      source: "manual",
      pending: false,
      notes: "lunch",
      recipient: "Cafe owner",
      recipientSource: "manual",
      sender: null,
      category: { name: "Dining", source: "manual" },
    });
    expect(await balanceOf(t, id)).toBe(48750);
    const s = (
      await t.call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30").expect(200)
    ).body;
    expect(s.totals).toMatchObject({ spendingMinor: 1250, incomeMinor: 0, count: 1 });
  });

  it("records money received with its sender", async () => {
    const t = app();
    const id = await account(t);
    const res = await add(
      t,
      base(id, {
        merchant: "Alex Smith",
        direction: "in",
        amountMinor: 8000,
        sender: "Alex Smith",
        recipient: "ignored",
        description: "Paid back for dinner",
      }),
    ).expect(201);
    expect(res.body).toMatchObject({
      amountMinor: -8000,
      name: "Paid back for dinner",
      sender: "Alex Smith",
      senderSource: "manual",
      recipient: null,
    });
    expect(await balanceOf(t, id)).toBe(8000);
    // Sender is searchable and exported.
    const found = (await t.call("get", "/api/transactions?q=alex").expect(200)).body;
    expect(found.total).toBe(1);
    const exported = (
      await t.call("post", "/api/exports").send({ kind: "transactions" }).expect(201)
    ).body;
    const csv = fs.readFileSync(exported.path, "utf8");
    expect(csv).toContain("recipient,sender,notes");
    expect(csv).toContain(",false,false,,Alex Smith,"); // recipient empty, sender filled
  });

  it("lets a transfer between your own accounts stay out of income and spending", async () => {
    const t = app();
    const id = await account(t);
    await add(
      t,
      base(id, {
        merchant: "ATM withdrawal",
        direction: "in",
        amountMinor: 20000,
        isTransfer: true,
      }),
    ).expect(201);
    const s = (
      await t.call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30").expect(200)
    ).body;
    expect(s.totals).toMatchObject({ incomeMinor: 0, spendingMinor: 0, count: 0 });
    expect(await balanceOf(t, id)).toBe(20000);
  });

  it("applies your rules when no category is chosen, and never overrides one you choose", async () => {
    const t = app();
    const id = await account(t);
    const dining = (await t.call("post", "/api/categories").send({ name: "Dining" }).expect(201))
      .body.id;
    const other = (await t.call("post", "/api/categories").send({ name: "Treats" }).expect(201))
      .body.id;
    await t
      .call("post", "/api/rules")
      .send({
        name: "Cafes",
        field: "merchant",
        operator: "contains",
        matchValue: "cafe",
        categoryId: dining,
      })
      .expect(201);
    const ruled = (await add(t, base(id)).expect(201)).body;
    expect(ruled.category).toMatchObject({ name: "Dining", source: "rule" });
    const chosen = (await add(t, base(id, { categoryId: other })).expect(201)).body;
    expect(chosen.category).toMatchObject({ name: "Treats", source: "manual" });
  });

  it("applies a rule that matches on the sender", async () => {
    const t = app();
    const id = await account(t);
    const income = (await t.call("post", "/api/categories").send({ name: "Gifts" }).expect(201))
      .body.id;
    await t
      .call("post", "/api/rules")
      .send({
        name: "From Mom",
        field: "sender",
        operator: "equals",
        matchValue: "Mom",
        categoryId: income,
      })
      .expect(201);
    const res = (
      await add(t, base(id, { merchant: "Birthday", direction: "in", sender: "Mom" })).expect(201)
    ).body;
    expect(res.category).toMatchObject({ name: "Gifts", source: "rule" });
  });

  it("works on a card: purchases raise what is owed, payments lower it", async () => {
    const t = app();
    const card = await account(t, {
      name: "Visa",
      kind: "credit_card",
      openingBalanceMinor: 10000,
    });
    await add(t, base(card, { amountMinor: 4000 })).expect(201);
    expect(await balanceOf(t, card)).toBe(14000);
    await add(
      t,
      base(card, { merchant: "Payment", direction: "in", amountMinor: 5000, isTransfer: true }),
    ).expect(201);
    expect(await balanceOf(t, card)).toBe(9000);
  });

  it("validates what you enter", async () => {
    const t = app();
    const id = await account(t);
    for (const bad of [
      { amountMinor: 0 },
      { amountMinor: -5 },
      { amountMinor: 12.5 },
      { amountMinor: 1e12 },
      { date: "2026-02-30" },
      { date: "yesterday" },
      { merchant: "   " },
      { direction: "sideways" },
      { categoryId: 99999 },
      { extra: true },
    ]) {
      await add(t, base(id, bad)).expect(400);
    }
    expect(await balanceOf(t, id)).toBe(0);
  });

  it("only adds to accounts you keep by hand", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    const connected = (bank.item.accounts[0] as { id: number }).id;
    await add(h as unknown as T, base(connected)).expect(409);
    const invest = (
      await h.call("post", "/api/investments/accounts").send({ name: "TSP" }).expect(201)
    ).body.id;
    await add(h as unknown as T, base(invest)).expect(409);
    await add(h as unknown as T, base(99999)).expect(404);
  });

  it("records a balance point each time, so net worth history includes cash", async () => {
    const t = app();
    const id = await account(t, { openingBalanceMinor: 10000 });
    await add(t, base(id)).expect(201);
    const history = (await t.call("get", "/api/analytics/net-worth-history").expect(200)).body;
    expect(history.accountsTotal).toBe(1);
    expect(history.points.at(-1).assetsMinor).toBe(8750);
    const net = (await t.call("get", "/api/analytics/overview").expect(200)).body;
    expect(net.cashMinor).toBe(8750);
  });

  it("is left alone by syncing, which only handles bank transactions", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const cash = await account(h as unknown as T, { openingBalanceMinor: 5000 });
    await add(h as unknown as T, base(cash)).expect(201);
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    h.advanceDays(40);
    await h.sync.syncItem(bank.item.id, "manual");
    const mine = (await h.call("get", `/api/transactions?accountId=${cash}`).expect(200)).body;
    expect(mine.total).toBe(2);
    expect(await balanceOf(h as unknown as T, cash)).toBe(3750);
  });
});

describe("editing and deleting", () => {
  it("lets you change every field of your own transaction, and the balances follow", async () => {
    const t = app();
    const wallet = await account(t, { openingBalanceMinor: 10000 });
    const jar = await account(t, { name: "Jar" });
    const id = (await add(t, base(wallet)).expect(201)).body.id;
    expect(await balanceOf(t, wallet)).toBe(8750);
    const res = await t
      .call("patch", `/api/transactions/${id}`)
      .send({
        accountId: jar,
        date: "2026-09-12",
        merchant: "Bakery",
        description: "Bread",
        amountMinor: 900,
        direction: "in",
        pending: true,
        sender: "Friend",
        notes: "refund",
      })
      .expect(200);
    expect(res.body).toMatchObject({
      accountId: jar,
      date: "2026-09-12",
      merchant: "Bakery",
      name: "Bread",
      amountMinor: -900,
      pending: true,
      sender: "Friend",
      notes: "refund",
      source: "manual",
    });
    expect(await balanceOf(t, wallet)).toBe(10000); // the purchase left this account
    expect(await balanceOf(t, jar)).toBe(900);
  });

  it("changes only the amount while keeping the direction, and only the direction while keeping the amount", async () => {
    const t = app();
    const id = await account(t);
    const tx = (await add(t, base(id)).expect(201)).body.id;
    expect(
      (await t.call("patch", `/api/transactions/${tx}`).send({ amountMinor: 2000 }).expect(200))
        .body.amountMinor,
    ).toBe(2000);
    expect(
      (await t.call("patch", `/api/transactions/${tx}`).send({ direction: "in" }).expect(200)).body
        .amountMinor,
    ).toBe(-2000);
    await t.call("patch", `/api/transactions/${tx}`).send({ amountMinor: 0 }).expect(400);
    await t.call("patch", `/api/transactions/${tx}`).send({ merchant: " " }).expect(400);
    await t.call("patch", `/api/transactions/${tx}`).send({ date: "2026-13-01" }).expect(400);
    expect(await balanceOf(t, id)).toBe(2000);
  });

  it("will not move a transaction to a connected account", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    const connected = (bank.item.accounts[0] as { id: number }).id;
    const cash = await account(h as unknown as T);
    const tx = (await add(h as unknown as T, base(cash)).expect(201)).body.id;
    await h.call("patch", `/api/transactions/${tx}`).send({ accountId: connected }).expect(409);
  });

  it("keeps the bank's date, amount, and account fixed, but still lets you categorize and annotate", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    const first = (await h.call("get", "/api/transactions?pageSize=1").expect(200)).body.items[0];
    for (const body of [
      { amountMinor: 5 },
      { date: "2026-01-01" },
      { direction: "in" },
      { description: "x" },
      { pending: true },
      { accountId: first.accountId },
    ]) {
      const res = await h.call("patch", `/api/transactions/${first.id}`).send(body).expect(409);
      expect(res.body.error).toBe("bank_transaction");
    }
    const cat = (await h.call("post", "/api/categories").send({ name: "Mine" }).expect(201)).body
      .id;
    const ok = await h
      .call("patch", `/api/transactions/${first.id}`)
      .send({ categoryId: cat, notes: "ok", sender: "Someone", merchant: "Renamed" })
      .expect(200);
    expect(ok.body).toMatchObject({
      notes: "ok",
      sender: "Someone",
      senderSource: "manual",
      merchant: "Renamed",
      source: "plaid",
    });
    expect(ok.body.providerMerchant).not.toBe("Renamed");
  });

  it("deletes your own transaction and updates the balance, but never a bank's", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    const cash = await account(h as unknown as T, { openingBalanceMinor: 10000 });
    const tx = (await add(h as unknown as T, base(cash)).expect(201)).body.id;
    expect(await balanceOf(h as unknown as T, cash)).toBe(8750);
    await h.call("delete", `/api/transactions/${tx}`).expect(204);
    expect(await balanceOf(h as unknown as T, cash)).toBe(10000);
    await h.call("delete", `/api/transactions/${tx}`).expect(404);
    const bankTx = (
      await h.call("get", "/api/transactions?pageSize=200").expect(200)
    ).body.items.find((x: { source: string }) => x.source === "plaid");
    const res = await h.call("delete", `/api/transactions/${bankTx.id}`).expect(409);
    expect(res.body.error).toBe("bank_transaction");
  });
});

describe("the sender field for bank transactions", () => {
  it("is filled in for money coming in, with the recipient for money going out", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    const items = (await h.call("get", "/api/transactions?pageSize=200&q=zelle").expect(200)).body
      .items;
    for (const t of items) {
      if (t.amountMinor < 0)
        expect(t).toMatchObject({ recipient: null, sender: expect.any(String) });
      else expect(t).toMatchObject({ sender: null, recipient: expect.any(String) });
    }
    expect(items.some((t: { sender: string | null }) => t.sender === "Alex Smith")).toBe(true);
  });

  it("shows your own correction in place of the detected sender, and a re-sync keeps it", async () => {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    const incoming = (
      await h.call("get", "/api/transactions?pageSize=200&q=zelle").expect(200)
    ).body.items.find((t: { amountMinor: number }) => t.amountMinor < 0);
    await h
      .call("patch", `/api/transactions/${incoming.id}`)
      .send({ sender: "Alexander Smith" })
      .expect(200);
    h.advanceDays(30);
    await h.sync.syncItem(bank.item.id, "manual");
    const again = (await h.call("get", `/api/transactions/${incoming.id}`).expect(200)).body;
    expect(again).toMatchObject({
      sender: "Alexander Smith",
      senderSource: "manual",
      providerSender: "Alex Smith",
    });
    await h.call("patch", `/api/transactions/${incoming.id}`).send({ sender: null }).expect(200);
    expect((await h.call("get", `/api/transactions/${incoming.id}`).expect(200)).body.sender).toBe(
      "Alex Smith",
    );
  });
});

describe("migrating who-sent-it", () => {
  it("moves the person on incoming transactions from recipient to sender", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "pf-sender-"));
    const old = truncatedMigrations(7);
    cleanups.push(() => {
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
    });
    const { db, sqlite } = createDb({ dataDir: data, key: TEST_DB_KEY });
    runMigrations(db, old);
    sqlite
      .prepare(
        "INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('A', 'depository', 'USD', 'x', 'x')",
      )
      .run();
    const insert = sqlite.prepare(
      "INSERT INTO transactions (account_id, date, name, amount_minor, currency, recipient, recipient_source, recipient_user, created_at, updated_at) VALUES (1, '2026-09-01', ?, ?, 'USD', ?, ?, ?, 'x', 'x')",
    );
    insert.run("Zelle from Alex", -5000, "Alex", "parsed", "Alex (edited)");
    insert.run("Zelle to Jane", 3000, "Jane", "parsed", null);
    insert.run("Coffee", 400, null, null, null);
    runMigrations(db, MIGRATIONS);
    const rows = sqlite
      .prepare(
        "SELECT name, recipient, recipient_source, recipient_user, sender, sender_source, sender_user, source FROM transactions ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      {
        name: "Zelle from Alex",
        recipient: null,
        recipient_source: null,
        recipient_user: null,
        sender: "Alex",
        sender_source: "parsed",
        sender_user: "Alex (edited)",
        source: "plaid",
      },
      {
        name: "Zelle to Jane",
        recipient: "Jane",
        recipient_source: "parsed",
        recipient_user: null,
        sender: null,
        sender_source: null,
        sender_user: null,
        source: "plaid",
      },
      {
        name: "Coffee",
        recipient: null,
        recipient_source: null,
        recipient_user: null,
        sender: null,
        sender_source: null,
        sender_user: null,
        source: "plaid",
      },
    ]);
    sqlite.close();
  });
});
