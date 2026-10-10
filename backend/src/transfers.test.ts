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
import { matchTransfers } from "./services/transfer.service.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}

const c = (
  id: number,
  accountId: number,
  date: string,
  amount: number,
  name = "x",
  category: string | null = null,
) => ({
  id,
  accountId,
  date,
  amount,
  currency: "USD",
  category,
  name,
});

describe("matching the two sides of a transfer", () => {
  it("pairs an outgoing and an incoming transaction of the same amount on different accounts", () => {
    expect(
      matchTransfers([
        c(1, 1, "2026-09-03", 30000, "ONLINE TRANSFER TO SAV"),
        c(2, 2, "2026-09-03", -30000, "ONLINE TRANSFER FROM CHK"),
      ]),
    ).toEqual([[1, 2]]);
  });

  it("allows the two sides to post a few days apart, but not many", () => {
    const side = (gap: number) =>
      matchTransfers([
        c(1, 1, "2026-09-03", 5000, "transfer"),
        c(2, 2, `2026-09-${String(3 + gap).padStart(2, "0")}`, -5000, "deposit"),
      ]);
    expect(side(4)).toEqual([[1, 2]]);
    expect(side(5)).toEqual([]);
  });

  it("does not pair on the same account, with a different amount, or in another currency", () => {
    expect(
      matchTransfers([
        c(1, 1, "2026-09-03", 5000, "transfer"),
        c(2, 1, "2026-09-03", -5000, "transfer"),
      ]),
    ).toEqual([]);
    expect(
      matchTransfers([
        c(1, 1, "2026-09-03", 5000, "transfer"),
        c(2, 2, "2026-09-03", -5001, "transfer"),
      ]),
    ).toEqual([]);
    const euro = { ...c(2, 2, "2026-09-03", -5000, "transfer"), currency: "EUR" };
    expect(matchTransfers([c(1, 1, "2026-09-03", 5000, "transfer"), euro])).toEqual([]);
  });

  it("needs one side to look like a transfer or payment, so a refund is not mistaken for one", () => {
    expect(
      matchTransfers([
        c(1, 1, "2026-09-03", 5000, "AMAZON"),
        c(2, 2, "2026-09-04", -5000, "AMAZON REFUND"),
      ]),
    ).toEqual([]);
    expect(
      matchTransfers([
        c(1, 1, "2026-09-03", 5000, "AMAZON"),
        c(2, 2, "2026-09-04", -5000, "Credit", "TRANSFER_IN"),
      ]),
    ).toEqual([[1, 2]]);
  });

  it("uses each transaction once and prefers the closest date", () => {
    const pairs = matchTransfers([
      c(1, 1, "2026-09-03", 5000, "transfer"),
      c(2, 2, "2026-09-01", -5000, "transfer"),
      c(3, 2, "2026-09-03", -5000, "transfer"),
    ]);
    expect(pairs).toEqual([[1, 3]]);
  });
});

describe("internal transfers on synced demo data", () => {
  async function synced() {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    return Object.assign(h, { itemId: bank.item.id as number });
  }
  const list = async (h: Awaited<ReturnType<typeof synced>>, q: string) =>
    (await h.call("get", `/api/transactions?pageSize=200&${q}`).expect(200)).body
      .items as Array<Row>;

  it("flags both sides of a checking-to-savings transfer, and says what each was matched with", async () => {
    const h = await synced();
    const rows = await list(h, "q=ONLINE%20TRANSFER");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r).toMatchObject({ isTransfer: true, transferSource: "auto" });
      expect(r.transferWith).toMatchObject({ accountName: expect.any(String) });
    }
    const out = rows.find((r) => r.amountMinor > 0)!;
    const into = rows.find((r) => r.id === out.transferWith!.id)!;
    expect(into.amountMinor).toBe(-out.amountMinor);
    expect(into.accountId).not.toBe(out.accountId);
  });

  it("does not treat a Zelle to or from a person as a transfer", async () => {
    const h = await synced();
    const zelle = await list(h, "q=zelle");
    expect(zelle.length).toBeGreaterThan(0);
    for (const z of zelle) expect(z).toMatchObject({ isTransfer: false, transferSource: null });
  });

  it("counts money a person sent as income and money sent to a person as spending", async () => {
    const h = await synced();
    const zelleIn = (await list(h, "q=zelle%20payment%20from"))[0]!;
    const zelleOut = (await list(h, "q=zelle%20payment%20to"))[0]!;
    const day = (t: Row) => `from=${t.date}&to=${t.date}`;
    const inSum = (await h.call("get", `/api/analytics/summary?${day(zelleIn)}`).expect(200)).body
      .totals;
    expect(inSum.incomeMinor).toBeGreaterThanOrEqual(-zelleIn.amountMinor);
    const outSum = (await h.call("get", `/api/analytics/summary?${day(zelleOut)}`).expect(200)).body
      .totals;
    expect(outSum.spendingMinor).toBeGreaterThanOrEqual(zelleOut.amountMinor);
  });

  it("leaves matched transfers out of spending and income", async () => {
    const h = await synced();
    const tr = (await list(h, "q=ONLINE%20TRANSFER")).find((t) => t.amountMinor > 0)!;
    const day = `from=${tr.date}&to=${tr.date}`;
    const without = (await h.call("get", `/api/analytics/summary?${day}`).expect(200)).body.totals;
    const all = (
      await h.call("get", `/api/analytics/summary?${day}&includeTransfers=1`).expect(200)
    ).body.totals;
    expect(all.count).toBe(without.count + 2);
    expect(all.spendingMinor - without.spendingMinor).toBe(tr.amountMinor);
  });

  it("lets the user say a matched transfer is not one, and keeps that after later syncs", async () => {
    const h = await synced();
    const tr = (await list(h, "q=ONLINE%20TRANSFER")).find((t) => t.amountMinor > 0)!;
    const res = await h
      .call("patch", `/api/transactions/${tr.id}`)
      .send({ isTransfer: false })
      .expect(200);
    expect(res.body).toMatchObject({ isTransfer: false, transferSource: "manual" });
    // The other side is released; with nothing to pair with it, it counts again.
    const other = (await h.call("get", `/api/transactions/${tr.transferWith!.id}`).expect(200))
      .body;
    expect(other.isTransfer).toBe(false);

    await h.sync.syncItem(h.itemId, "manual");
    const after = (await h.call("get", `/api/transactions/${tr.id}`).expect(200)).body;
    expect(after).toMatchObject({ isTransfer: false, transferSource: "manual" });
  });

  it("lets the user mark a bank transaction as a transfer, and hand the decision back", async () => {
    const h = await synced();
    const lunch = (await list(h, "q=chipotle"))[0]!;
    expect(lunch.isTransfer).toBe(false);
    const on = await h
      .call("patch", `/api/transactions/${lunch.id}`)
      .send({ isTransfer: true })
      .expect(200);
    expect(on.body).toMatchObject({ isTransfer: true, transferSource: "manual" });
    // A bank transaction's amount and date still cannot be changed.
    await h.call("patch", `/api/transactions/${lunch.id}`).send({ amountMinor: 5 }).expect(409);
    const back = await h
      .call("patch", `/api/transactions/${lunch.id}`)
      .send({ isTransfer: null })
      .expect(200);
    expect(back.body).toMatchObject({ isTransfer: false, transferSource: null });
  });

  it("forgets an automatic match when the other side goes away", async () => {
    const h = await synced();
    const tr = (await list(h, "q=ONLINE%20TRANSFER")).find((t) => t.amountMinor > 0)!;
    // Remove the other side directly, as a provider removal would, then run detection again.
    h.sqlite.prepare("delete from transactions where id = ?").run(tr.transferWith!.id);
    await h.sync.syncItem(h.itemId, "manual");
    const row = (await h.call("get", `/api/transactions/${tr.id}`).expect(200)).body;
    expect(row).toMatchObject({ isTransfer: false, transferSource: null, transferWith: null });
  });
});

describe("transfers with accounts kept by hand", () => {
  it("pairs a cash withdrawal with the ATM cash arriving in a wallet", async () => {
    const t = app();
    const wallet = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash" })
        .expect(201)
    ).body.id;
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id;
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: checking,
        date: "2026-09-10",
        merchant: "ATM withdrawal",
        amountMinor: 8000,
        direction: "out",
      })
      .expect(201);
    const cash = await t
      .call("post", "/api/transactions")
      .send({
        accountId: wallet,
        date: "2026-09-10",
        merchant: "Cash from ATM transfer",
        amountMinor: 8000,
        direction: "in",
      })
      .expect(201);
    expect(cash.body).toMatchObject({ isTransfer: true, transferSource: "auto" });
    const range = "from=2026-09-01&to=2026-09-30";
    const s = (await t.call("get", `/api/analytics/summary?${range}`).expect(200)).body.totals;
    expect(s.spendingMinor).toBe(0);
    expect(s.incomeMinor).toBe(0);

    // Deleting the cash side releases the withdrawal, which then counts as spending.
    await t.call("delete", `/api/transactions/${cash.body.id}`).expect(204);
    const s2 = (await t.call("get", `/api/analytics/summary?${range}`).expect(200)).body.totals;
    expect(s2.spendingMinor).toBe(8000);
  });

  it("an opening balance and a hand-flagged transfer are never changed by detection", async () => {
    const t = app();
    const a = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash", openingBalanceMinor: 5000 })
        .expect(201)
    ).body.id;
    const tx = await t
      .call("post", "/api/transactions")
      .send({
        accountId: a,
        date: "2026-09-10",
        merchant: "Moved to jar",
        amountMinor: 700,
        direction: "out",
        isTransfer: true,
      })
      .expect(201);
    expect(tx.body).toMatchObject({ isTransfer: true, transferSource: "manual" });
    const all = (await t.call("get", `/api/transactions?accountId=${a}&pageSize=50`)).body.items;
    expect(all.find((r: { merchant: string }) => r.merchant === "Opening balance")).toMatchObject({
      isTransfer: true,
      transferSource: "system",
    });
  });
});

describe("income and spending from other people", () => {
  it("counts money a person sent as income, but a plain refund still reduces spending", async () => {
    const t = app();
    const a = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id;
    const add = (body: Record<string, unknown>) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId: a, date: "2026-09-10", amountMinor: 4000, ...body })
        .expect(201);
    await add({ merchant: "Birthday gift", direction: "in", sender: "Grandma Rose" });
    await add({ merchant: "Store refund", direction: "in" });
    await add({
      merchant: "Rent",
      direction: "out",
      amountMinor: 90000,
      recipient: "Landlord Lee",
    });
    const s = (
      await t.call("get", "/api/analytics/summary?from=2026-09-01&to=2026-09-30").expect(200)
    ).body.totals;
    expect(s.incomeMinor).toBe(4000); // only the gift from a person
    expect(s.spendingMinor).toBe(90000 - 4000); // rent, less the refund
  });
});

describe("upgrading from the version that flagged every person payment as a transfer", () => {
  it("clears the old flags on bank rows and keeps the ones the user set by hand", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-up-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { db, sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
    const old = truncatedMigrations(9); // everything before 0009
    cleanups.push(() => fs.rmSync(old, { recursive: true, force: true }));
    runMigrations(db, old);
    sqlite.exec(`
      insert into accounts (id, name, type, currency, created_at, updated_at) values (1, 'Checking', 'depository', 'USD', 'x', 'x');
      insert into transactions (account_id, date, name, amount_minor, currency, source, is_transfer, created_at, updated_at) values
        (1, '2026-09-01', 'Zelle payment to Jane', 5000, 'USD', 'plaid', 1, 'x', 'x'),
        (1, '2026-09-02', 'Opening balance', -100000, 'USD', 'manual', 1, 'x', 'x'),
        (1, '2026-09-03', 'Moved to jar', 700, 'USD', 'manual', 1, 'x', 'x');
    `);
    runMigrations(db, MIGRATIONS);
    const rows = sqlite
      .prepare("select name, is_transfer as t, transfer_source as s from transactions order by id")
      .all() as Array<{ name: string; t: number; s: string | null }>;
    expect(rows).toEqual([
      { name: "Zelle payment to Jane", t: 0, s: null },
      { name: "Opening balance", t: 1, s: "system" },
      { name: "Moved to jar", t: 1, s: "manual" },
    ]);
    sqlite.close();
  });
});

/** The few fields of a transaction these tests read. */
interface Row {
  id: number;
  date: string;
  accountId: number;
  amountMinor: number;
  isTransfer: boolean;
  transferSource: string | null;
  transferWith: { id: number; accountName: string } | null;
}
