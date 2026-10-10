import { and, count, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accounts,
  balanceSnapshots,
  creditLimitHistory,
  plaidItems,
  syncRuns,
  transactions,
} from "../../drizzle/schema.js";
import { FakePlaidGateway, type FakeGatewayOptions } from "./plaid/fake-gateway.js";
import { pageLedger } from "./plaid/fake-ledger.js";
import { PlaidGatewayError, type PlaidGateway, type TransactionSyncPage } from "./plaid/gateway.js";
import { createSyncService, type SyncService } from "./services/sync.service.js";
import { linkDemoBank, makeTestApp } from "./test-helpers.js";

/** A demo gateway whose behaviour tests can bend: record calls, fail, corrupt, or pause. */
class TestGateway extends FakePlaidGateway {
  syncCalls = 0;
  failWith: PlaidGatewayError | null = null;
  /** Throw this error on the Nth call to syncTransactions (1-based), then behave normally. */
  failOnCall = new Map<number, PlaidGatewayError>();
  /** Make the Nth page contain a transaction with an invalid amount. */
  corruptCall: number | null = null;
  /** When set, syncTransactions waits for this before answering. */
  gate: Promise<void> | null = null;

  override async syncTransactions(
    token: string,
    cursor: string | null,
  ): Promise<TransactionSyncPage> {
    this.syncCalls += 1;
    const call = this.syncCalls;
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    const scripted = this.failOnCall.get(call);
    if (scripted) throw scripted;
    const page = await super.syncTransactions(token, cursor);
    if (this.corruptCall === call && page.added.length > 3) {
      page.added[3] = { ...page.added[3]!, amount: Number.NaN };
    }
    return page;
  }
}

const START = new Date("2026-09-01T12:00:00Z");

function harness(options: FakeGatewayOptions = { pageSize: 25 }) {
  const clock = { now: new Date(START) };
  const gateway = new TestGateway({ now: () => clock.now, ...options });
  let sync!: SyncService;
  const ctx = makeTestApp(({ db, cipher }) => {
    sync = createSyncService({ db, cipher, getGateway: () => gateway, now: () => clock.now });
    return { getGateway: () => gateway, sync };
  });
  const advanceMinutes = (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
  };
  const advanceDays = (days: number) => advanceMinutes(days * 24 * 60);
  const txCount = () => ctx.db.select({ n: count() }).from(transactions).get()!.n;
  const item = (id: number) => ctx.db.select().from(plaidItems).where(eq(plaidItems.id, id)).get()!;
  const setSetting = (patch: Record<string, number>) =>
    ctx.call("patch", "/api/settings").send(patch).expect(200);
  /** How many transactions a clean full pull would produce for this item as of the clock. */
  const expectedFullPull = (itemId: number) => {
    const plaidItemId = item(itemId).plaidItemId;
    const list = [0, 1, 2].map((index) => ({
      accountId: `acct-fake~${plaidItemId}~${index}`,
      index,
    }));
    let total = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = pageLedger(
        "ins_fake_bank",
        list,
        cursor,
        clock.now.toISOString().slice(0, 10),
        25,
      );
      total += page.added.length;
      cursor = page.nextCursor;
      if (!page.hasMore) return total;
    }
  };
  return {
    clock,
    gateway,
    sync,
    ctx,
    advanceMinutes,
    advanceDays,
    txCount,
    item,
    setSetting,
    expectedFullPull,
  };
}

type Harness = ReturnType<typeof harness>;
let h: Harness;
let itemId: number;

beforeEach(async () => {
  h = harness();
  itemId = (await linkDemoBank(h.ctx.call)).item.id;
});
afterEach(() => h.ctx.cleanup());

describe("first sync", () => {
  it("pulls the history across several pages and stores it", async () => {
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run).toMatchObject({ status: "success", trigger: "manual", errorCode: null });
    expect(run.added).toBe(h.txCount());
    expect(run.added).toBe(h.expectedFullPull(itemId));
    expect(run.added).toBeGreaterThan(60);
    expect(h.gateway.syncCalls).toBeGreaterThan(2); // more than one page
    expect(run.modified).toBe(0);
    expect(run.removed).toBe(0);
  });

  it("saves the cursor and the time of the successful sync", async () => {
    await h.sync.syncItem(itemId, "manual");
    const item = h.item(itemId);
    expect(item.syncCursor).toBe("fake~2026-09-01");
    expect(item.lastSuccessfulSyncAt).toBe(START.toISOString());
    expect(item.status).toBe("active");
  });

  it("stores amounts as minor units in Plaid's sign convention", async () => {
    await h.sync.syncItem(itemId, "manual");
    const pay = h.ctx.db
      .select()
      .from(transactions)
      .where(like(transactions.name, "ACME CORP%"))
      .get()!;
    expect(pay.amountMinor).toBe(-250000); // income: money entering is negative
    const rent = h.ctx.db
      .select()
      .from(transactions)
      .where(like(transactions.name, "OAK STREET%"))
      .get()!;
    expect(rent.amountMinor).toBe(145000); // money leaving is positive
    expect(rent.currency).toBe("USD");
  });

  it("records a balance snapshot for every account", async () => {
    await h.sync.syncItem(itemId, "manual");
    const snaps = h.ctx.db.select().from(balanceSnapshots).all();
    expect(snaps).toHaveLength(3);
    expect(snaps.find((s) => s.currentBalanceMinor === 11000)).toBeDefined();
    expect(snaps.every((s) => s.observedAt === START.toISOString())).toBe(true);
  });

  it("notes the credit limit the first time it sees one", async () => {
    await h.sync.syncItem(itemId, "manual");
    const history = h.ctx.db.select().from(creditLimitHistory).all();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      limitMinor: 200000,
      source: "plaid",
      effectiveDate: "2026-09-01",
    });
  });

  it("creates pending transactions for the most recent days", async () => {
    await h.sync.syncItem(itemId, "manual");
    const pending = h.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.pending, true))
      .all();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((t) => t.date >= "2026-08-31")).toBe(true);
  });

  it("stores each sync as a run in the history", async () => {
    await h.sync.syncItem(itemId, "manual");
    const runs = h.ctx.db.select().from(syncRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.finishedAt).not.toBeNull();
  });
});

describe("repeating and catching up", () => {
  it("syncing again the same day adds nothing and duplicates nothing", async () => {
    await h.sync.syncItem(itemId, "manual");
    const before = h.txCount();
    const again = await h.sync.syncItem(itemId, "manual");
    expect(again).toMatchObject({ status: "success", added: 0, modified: 0, removed: 0 });
    expect(h.txCount()).toBe(before);
  });

  it("catches up after a gap and turns pending transactions into posted ones in place", async () => {
    await h.sync.syncItem(itemId, "manual");
    const pendingBefore = h.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.pending, true))
      .all();
    expect(pendingBefore.length).toBeGreaterThan(0);

    h.advanceDays(10);
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("success");
    expect(run.added).toBeGreaterThan(0);
    expect(run.modified).toBeGreaterThanOrEqual(pendingBefore.length);

    // Each formerly pending row is the SAME row, now posted, pointing at its pending ID.
    for (const before of pendingBefore) {
      const after = h.ctx.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, before.id))
        .get()!;
      expect(after.pending).toBe(false);
      expect(after.plaidTransactionId).toMatch(/^txn-fake~/);
      expect(after.pendingPlaidTransactionId).toBe(before.plaidTransactionId);
    }
    // Only the newest days are still pending, and no stale pending ID is left behind.
    const stillPending = h.ctx.db
      .select()
      .from(transactions)
      .where(like(transactions.plaidTransactionId, "ptxn-fake~%"))
      .all();
    expect(stillPending.every((t) => t.date >= "2026-09-10")).toBe(true);
    expect(h.item(itemId).syncCursor).toBe("fake~2026-09-11");
  });

  it("keeps the user's edits when a sync refreshes the same transactions", async () => {
    await h.sync.syncItem(itemId, "manual");
    const pending = h.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.pending, true))
      .get()!;
    const zelle = h.ctx.db
      .select()
      .from(transactions)
      .where(like(transactions.name, "Zelle payment to%"))
      .get()!;
    for (const row of [pending, zelle]) {
      h.ctx.db
        .update(transactions)
        .set({
          notesUser: "my note",
          merchantNameUser: "My Merchant",
          recipientUser: "Manual Person",
        })
        .where(eq(transactions.id, row.id))
        .run();
    }

    h.advanceDays(6);
    await h.sync.syncItem(itemId, "manual");

    for (const row of [pending, zelle]) {
      const after = h.ctx.db.select().from(transactions).where(eq(transactions.id, row.id)).get()!;
      expect(after).toMatchObject({
        notesUser: "my note",
        merchantNameUser: "My Merchant",
        recipientUser: "Manual Person",
      });
    }
    // The pending one carried its edits across to the posted transaction.
    expect(
      h.ctx.db.select().from(transactions).where(eq(transactions.id, pending.id)).get()!.pending,
    ).toBe(false);
  });

  it("applies the whole gap even when it is months long", async () => {
    await h.sync.syncItem(itemId, "manual");
    h.advanceDays(75);
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("success");
    expect(run.added).toBeGreaterThan(50);
    expect(h.item(itemId).syncCursor).toBe("fake~2026-11-15");
  });

  it("records a new balance snapshot on every successful sync", async () => {
    await h.sync.syncItem(itemId, "manual");
    h.advanceMinutes(60);
    await h.sync.syncItem(itemId, "manual");
    expect(h.ctx.db.select().from(balanceSnapshots).all()).toHaveLength(6);
  });
});

describe("recipients", () => {
  it("captures Zelle recipients from descriptions and payee metadata, and keeps direction", async () => {
    await h.sync.syncItem(itemId, "manual");
    const res = await h.ctx.call("get", "/api/transactions?pageSize=200&q=zelle").expect(200);
    const out = res.body.items.find((t: { name: string }) => t.name.startsWith("Zelle payment to"));
    const into = res.body.items.find((t: { name: string }) =>
      t.name.startsWith("Zelle payment from"),
    );
    expect(out).toMatchObject({
      recipient: "Jane Doe",
      recipientSource: "parsed",
      // A payment to another person is not a transfer between the user's own accounts.
      isTransfer: false,
    });
    expect(out.amountMinor).toBeGreaterThan(0);
    // Money coming in names its sender, not a recipient.
    expect(into).toMatchObject({
      sender: "Alex Smith",
      senderSource: "parsed",
      recipient: null,
      isTransfer: false,
    });
    expect(into.amountMinor).toBeLessThan(0);
    expect(out.sender).toBeNull();

    const bill = (await h.ctx.call("get", "/api/transactions?pageSize=200&q=bill").expect(200)).body
      .items[0];
    expect(bill).toMatchObject({ recipient: "Sam Lee", recipientSource: "plaid" });
  });

  it("shows a manually entered recipient in place of the detected one", async () => {
    await h.sync.syncItem(itemId, "manual");
    const row = h.ctx.db
      .select()
      .from(transactions)
      .where(like(transactions.name, "Zelle payment to%"))
      .get()!;
    h.ctx.db
      .update(transactions)
      .set({ recipientUser: "Corrected Name" })
      .where(eq(transactions.id, row.id))
      .run();
    const res = await h.ctx.call("get", "/api/transactions?pageSize=200&q=zelle").expect(200);
    const shown = res.body.items.find((t: { id: number }) => t.id === row.id);
    expect(shown).toMatchObject({ recipient: "Corrected Name", recipientSource: "manual" });
  });

  it("leaves ordinary purchases without a recipient", async () => {
    await h.sync.syncItem(itemId, "manual");
    const res = await h.ctx.call("get", "/api/transactions?pageSize=200&q=whole").expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const t of res.body.items) expect(t).toMatchObject({ recipient: null, isTransfer: false });
  });
});

describe("credit limits", () => {
  const cardId = () =>
    h.ctx.db.select().from(accounts).where(eq(accounts.subtype, "credit card")).get()!.id;

  it("adds an observed entry only when the limit actually changes", async () => {
    await h.sync.syncItem(itemId, "manual");
    await h.sync.syncItem(itemId, "manual");
    expect(h.ctx.db.select().from(creditLimitHistory).all()).toHaveLength(1);

    h.advanceDays(3);
    h.gateway.simulateCreditLimit(h.item(itemId).plaidItemId, 2500);
    await h.sync.syncItem(itemId, "manual");

    const res = await h.ctx.call("get", `/api/accounts/${cardId()}/credit-limits`).expect(200);
    expect(res.body.current).toMatchObject({ limitMinor: 250000, source: "plaid" });
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({
      limitMinor: 250000,
      effectiveDate: "2026-09-04",
      changeMinor: 50000,
      changePercent: 25,
    });
    expect(res.body.entries[1]).toMatchObject({
      limitMinor: 200000,
      changeMinor: null,
      changePercent: null,
    });
  });

  it("tracks decreases too", async () => {
    await h.sync.syncItem(itemId, "manual");
    h.advanceDays(2);
    h.gateway.simulateCreditLimit(h.item(itemId).plaidItemId, 1500);
    await h.sync.syncItem(itemId, "manual");
    const res = await h.ctx.call("get", `/api/accounts/${cardId()}/credit-limits`).expect(200);
    expect(res.body.entries[0]).toMatchObject({
      limitMinor: 150000,
      changeMinor: -50000,
      changePercent: -25,
    });
  });

  it("does not add an entry when a manual entry already says the same thing, and never edits manual entries", async () => {
    await h.sync.syncItem(itemId, "manual");
    h.advanceDays(1);
    h.ctx.db
      .insert(creditLimitHistory)
      .values({
        accountId: cardId(),
        limitMinor: 250000,
        currency: "USD",
        effectiveDate: "2026-09-02",
        source: "manual",
        note: "called the bank",
        createdAt: "x",
        updatedAt: "x",
      })
      .run();
    h.gateway.simulateCreditLimit(h.item(itemId).plaidItemId, 2500);
    await h.sync.syncItem(itemId, "manual");

    const rows = h.ctx.db.select().from(creditLimitHistory).all();
    expect(rows).toHaveLength(2); // the first observed one plus the manual one; nothing new
    const manual = rows.find((r) => r.source === "manual")!;
    expect(manual).toMatchObject({
      limitMinor: 250000,
      note: "called the bank",
      effectiveDate: "2026-09-02",
      createdAt: "x",
    });
  });

  it("shows the current limit on the account", async () => {
    await h.sync.syncItem(itemId, "manual");
    const res = await h.ctx.call("get", "/api/accounts").expect(200);
    const card = res.body.find((a: { subtype: string }) => a.subtype === "credit card");
    const checking = res.body.find((a: { subtype: string }) => a.subtype === "checking");
    expect(card.creditLimitMinor).toBe(200000);
    expect(checking.creditLimitMinor).toBeNull();
  });

  it("returns 404 for an unknown account", async () => {
    await h.ctx.call("get", "/api/accounts/9999/credit-limits").expect(404);
  });
});

describe("safety of each page", () => {
  it("stores a page and moves the cursor together, never one without the other", async () => {
    h.gateway.corruptCall = 2; // the second page contains an unusable amount
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("error");
    expect(run.errorMessage).toMatch(/no valid amount/i);

    // The first page is fully stored with its cursor; the second left no trace at all.
    expect(h.txCount()).toBe(25);
    expect(h.item(itemId).syncCursor).toBe("fake~2026-09-01~25~none");
    expect(h.item(itemId).lastSuccessfulSyncAt).toBeNull();
    expect(h.ctx.db.select().from(balanceSnapshots).all()).toHaveLength(0);
  });

  it("resumes from the saved cursor after a failure and ends with no duplicates", async () => {
    h.gateway.corruptCall = 2;
    await h.sync.syncItem(itemId, "manual");
    h.gateway.corruptCall = null;
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("success");
    expect(h.txCount()).toBe(h.expectedFullPull(itemId));
    expect(h.item(itemId).syncCursor).toBe("fake~2026-09-01");
  });

  it("restarts the pass when the provider reports changes mid-pagination", async () => {
    h.gateway.failOnCall.set(
      3,
      new PlaidGatewayError(
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        "TRANSACTIONS_ERROR",
        "Data changed.",
      ),
    );
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("success");
    expect(h.txCount()).toBe(h.expectedFullPull(itemId));
    expect(run.added).toBe(h.expectedFullPull(itemId)); // restarted work is not counted twice
  });

  it("gives up on endless mid-pagination changes instead of looping", async () => {
    h.gateway.failWith = new PlaidGatewayError(
      "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
      "TRANSACTIONS_ERROR",
      "Data changed.",
    );
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("error");
    expect(h.gateway.syncCalls).toBeLessThanOrEqual(5);
  });

  it("recovers from an invalid cursor by re-pulling and reconciling", async () => {
    await h.sync.syncItem(itemId, "manual");
    const accountId = h.ctx.db.select().from(accounts).get()!.id;
    const insertRow = (plaidId: string, date: string) =>
      h.ctx.db
        .insert(transactions)
        .values({
          accountId,
          plaidTransactionId: plaidId,
          date,
          name: plaidId,
          amountMinor: 100,
          currency: "USD",
          createdAt: "x",
          updatedAt: "x",
        })
        .run();
    insertRow("txn-gone-in-window", "2026-08-15"); // inside the re-pulled window, not returned: stale
    insertRow("txn-older-than-window", "2020-01-01"); // outside the window: must be kept
    h.ctx.db
      .update(plaidItems)
      .set({ syncCursor: "garbage" })
      .where(eq(plaidItems.id, itemId))
      .run();
    const before = h.txCount() - 2;

    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("success");
    const ids = h.ctx.db
      .select({ id: transactions.plaidTransactionId })
      .from(transactions)
      .all()
      .map((r) => r.id);
    expect(ids).not.toContain("txn-gone-in-window");
    expect(ids).toContain("txn-older-than-window");
    expect(h.txCount()).toBe(before + 1);
    expect(run.removed).toBe(1);
    expect(h.item(itemId).syncCursor).toBe("fake~2026-09-01");
  });
});

describe("failures that are not the app's fault", () => {
  it("treats being offline as normal: nothing is marked broken and no time is recorded", async () => {
    h.gateway.failWith = new PlaidGatewayError(
      "NETWORK_ERROR",
      "NETWORK",
      "Could not reach Plaid.",
    );
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run).toMatchObject({ status: "offline", errorCode: "NETWORK_ERROR" });
    expect(h.item(itemId)).toMatchObject({ status: "active", lastSuccessfulSyncAt: null });
  });

  it("flags a connection that needs the user to sign in again", async () => {
    await h.sync.syncItem(itemId, "manual");
    h.gateway.simulateLoginRequired(h.item(itemId).plaidItemId);
    h.advanceMinutes(60);
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run).toMatchObject({ status: "error", errorCode: "ITEM_LOGIN_REQUIRED" });
    expect(h.item(itemId)).toMatchObject({
      status: "login_required",
      lastErrorCode: "ITEM_LOGIN_REQUIRED",
    });
  });

  it("reports data that is not ready yet as pending, not as an error", async () => {
    h.gateway.failWith = new PlaidGatewayError("PRODUCT_NOT_READY", "ITEM_ERROR", "not ready");
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run.status).toBe("pending");
    expect(run.errorMessage).toMatch(/try again in a few minutes/i);
    expect(h.item(itemId).status).toBe("active");
  });

  it("reports an unreadable token as an encryption problem and leaves the connection alone", async () => {
    h.ctx.db
      .update(plaidItems)
      .set({ accessTokenEncrypted: "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
      .where(eq(plaidItems.id, itemId))
      .run();
    const run = await h.sync.syncItem(itemId, "manual");
    expect(run).toMatchObject({ status: "error", errorCode: "token_unreadable" });
    expect(h.item(itemId).status).toBe("active");
    expect(h.gateway.syncCalls).toBe(0);
  });

  it("refuses to sync a connection from a different environment", async () => {
    // The connection was created in demo mode; a service answering as Sandbox must not touch it.
    const other = { environment: "sandbox" } as unknown as PlaidGateway;
    const run = await createSyncService({
      db: h.ctx.db,
      cipher: h.ctx.cipher,
      getGateway: () => other,
    }).syncItem(itemId, "manual");
    expect(run).toMatchObject({ status: "error", errorCode: "wrong_environment" });
  });

  it("returns 404 for an unknown connection", async () => {
    await expect(h.sync.syncItem(9999, "manual")).rejects.toMatchObject({ status: 404 });
  });
});

describe("running at the same time", () => {
  it("joins a sync already in progress instead of pulling twice", async () => {
    let release!: () => void;
    h.gateway.gate = new Promise((resolve) => (release = resolve));
    const first = h.sync.syncItem(itemId, "manual");
    const second = h.sync.syncItem(itemId, "launch");
    expect(h.sync.status().syncing).toBe(true);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(h.ctx.db.select().from(syncRuns).all()).toHaveLength(1);
    expect(h.sync.status().syncing).toBe(false);
    expect(h.txCount()).toBe(h.expectedFullPull(itemId));
  });

  it("syncs every connection when asked for all", async () => {
    const second = (await linkDemoBank(h.ctx.call, "ins_fake_brokerage", "Fake Brokerage")).item.id;
    const result = await h.sync.syncAll({ trigger: "manual", force: true });
    expect(result.runs.map((r) => r.itemId).sort()).toEqual([itemId, second].sort());
    expect(result.runs.every((r) => r.status === "success")).toBe(true);
    expect(h.item(second).lastSuccessfulSyncAt).not.toBeNull();
  });
});

describe("launch sync and the editable cooldown", () => {
  it("syncs on the first launch", async () => {
    const result = await h.sync.runLaunchSync();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ trigger: "launch", status: "success" });
  });

  it("skips connections synced within the cooldown, even after relaunching", async () => {
    await h.sync.runLaunchSync();
    h.advanceMinutes(10); // default cooldown is 30 minutes
    const result = await h.sync.runLaunchSync();
    expect(result.runs).toHaveLength(0);
    expect(result.skipped).toEqual([
      { itemId, institutionName: "First Platypus Bank", reason: "cooldown" },
    ]);
  });

  it("syncs again once the cooldown has passed", async () => {
    await h.sync.runLaunchSync();
    h.advanceMinutes(31);
    expect((await h.sync.runLaunchSync()).runs).toHaveLength(1);
  });

  it("uses the cooldown stored in the database, so a new service instance behaves the same", async () => {
    await h.sync.runLaunchSync();
    h.advanceMinutes(10);
    const relaunched = createSyncService({
      db: h.ctx.db,
      cipher: h.ctx.cipher,
      getGateway: () => h.gateway,
      now: () => h.clock.now,
    });
    expect((await relaunched.runLaunchSync()).skipped).toHaveLength(1);
  });

  it("applies an edited cooldown immediately: shorter makes it due, longer makes it wait", async () => {
    await h.sync.runLaunchSync();
    h.advanceMinutes(10);
    expect((await h.sync.runLaunchSync()).runs).toHaveLength(0); // 10 < 30

    await h.setSetting({ syncCooldownMinutes: 5 });
    expect((await h.sync.runLaunchSync()).runs).toHaveLength(1); // 10 >= 5, no restart needed

    h.advanceMinutes(120);
    await h.setSetting({ syncCooldownMinutes: 24 * 60 });
    expect((await h.sync.runLaunchSync()).runs).toHaveLength(0); // 120 < 1440
  });

  it("a cooldown of zero syncs on every launch", async () => {
    await h.setSetting({ syncCooldownMinutes: 0 });
    await h.sync.runLaunchSync();
    expect((await h.sync.runLaunchSync()).runs).toHaveLength(1);
  });

  it("the Sync button ignores the cooldown", async () => {
    await h.sync.runLaunchSync();
    h.advanceMinutes(1);
    const res = await h.ctx.call("post", "/api/sync").send({}).expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({ trigger: "manual", status: "success" });
  });

  it("a failed attempt does not reset the cooldown", async () => {
    await h.sync.runLaunchSync();
    h.advanceMinutes(40);
    h.gateway.failWith = new PlaidGatewayError("NETWORK_ERROR", "NETWORK", "offline");
    const failed = await h.sync.runLaunchSync();
    expect(failed.runs[0]!.status).toBe("offline");
    h.gateway.failWith = null;
    const retried = await h.sync.runLaunchSync(); // still due: the last SUCCESS is 40 minutes old
    expect(retried.runs).toHaveLength(1);
    expect(retried.runs[0]!.status).toBe("success");
  });

  it("does not auto-sync a connection that needs sign-in", async () => {
    await h.sync.runLaunchSync();
    h.gateway.simulateLoginRequired(h.item(itemId).plaidItemId);
    h.advanceMinutes(60);
    expect((await h.sync.runLaunchSync()).runs[0]!.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    const again = await h.sync.runLaunchSync();
    expect(again.runs).toHaveLength(0);
    expect(again.skipped[0]!.reason).toBe("needs_signin");
  });

  it("cleans up runs that were still marked running when the app last closed", async () => {
    h.ctx.db
      .insert(syncRuns)
      .values({
        plaidItemId: itemId,
        trigger: "launch",
        status: "running",
        startedAt: "2026-08-31T00:00:00Z",
      })
      .run();
    await h.sync.runLaunchSync();
    const stuck = h.ctx.db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.errorCode, "interrupted")))
      .all();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.status).toBe("error");
  });
});

describe("the editable sync interval while the app is open", () => {
  it("does nothing while the interval is 0 (off)", async () => {
    await h.sync.runLaunchSync();
    h.advanceDays(2);
    const result = await h.sync.runIntervalTick();
    expect(result.runs).toHaveLength(0);
  });

  it("syncs once the interval has passed, and applies edits at once", async () => {
    await h.sync.runLaunchSync();
    await h.setSetting({ autoSyncIntervalMinutes: 10 });
    h.advanceMinutes(5);
    expect((await h.sync.runIntervalTick()).runs).toHaveLength(0);
    h.advanceMinutes(6);
    const due = await h.sync.runIntervalTick();
    expect(due.runs).toHaveLength(1);
    expect(due.runs[0]!.trigger).toBe("interval");

    h.advanceMinutes(11);
    await h.setSetting({ autoSyncIntervalMinutes: 20 }); // longer interval: no longer due
    expect((await h.sync.runIntervalTick()).runs).toHaveLength(0);
    await h.setSetting({ autoSyncIntervalMinutes: 0 }); // turned off again
    h.advanceDays(1);
    expect((await h.sync.runIntervalTick()).runs).toHaveLength(0);
  });

  it("does not hammer a failing connection: retries are spaced by the interval", async () => {
    await h.sync.runLaunchSync();
    await h.setSetting({ autoSyncIntervalMinutes: 10 });
    h.advanceMinutes(11);
    h.gateway.failWith = new PlaidGatewayError("NETWORK_ERROR", "NETWORK", "offline");
    expect((await h.sync.runIntervalTick()).runs[0]!.status).toBe("offline");
    const callsAfterFailure = h.gateway.syncCalls;
    h.advanceMinutes(2);
    expect((await h.sync.runIntervalTick()).runs).toHaveLength(0);
    expect(h.gateway.syncCalls).toBe(callsAfterFailure);
    h.advanceMinutes(9);
    h.gateway.failWith = null;
    expect((await h.sync.runIntervalTick()).runs[0]!.status).toBe("success");
  });

  it("never retries more often than every 5 minutes, whatever the interval", async () => {
    await h.sync.runLaunchSync();
    await h.setSetting({ autoSyncIntervalMinutes: 1 });
    h.advanceMinutes(2);
    h.gateway.failWith = new PlaidGatewayError("NETWORK_ERROR", "NETWORK", "offline");
    expect((await h.sync.runIntervalTick()).runs).toHaveLength(1);
    h.advanceMinutes(2);
    expect((await h.sync.runIntervalTick()).runs).toHaveLength(0);
    h.advanceMinutes(4);
    expect((await h.sync.runIntervalTick()).runs).toHaveLength(1);
  });
});

describe("sync status and the API", () => {
  it("reports the sync state of each connection", async () => {
    expect(h.sync.status()).toMatchObject({
      environment: "fake",
      syncing: false,
      cooldownMinutes: 30,
      intervalMinutes: 0,
      items: [
        {
          itemId,
          lastSuccessfulSyncAt: null,
          lastRun: null,
          launchSyncEligibleAt: null,
          nextAutoSyncAt: null,
        },
      ],
    });
    await h.sync.syncItem(itemId, "manual");
    await h.setSetting({ autoSyncIntervalMinutes: 15 });
    const item = h.sync.status().items[0]!;
    expect(item.lastRun).toMatchObject({ status: "success", trigger: "manual" });
    expect(item.launchSyncEligibleAt).toBe("2026-09-01T12:30:00.000Z");
    expect(item.nextAutoSyncAt).toBe("2026-09-01T12:15:00.000Z");
  });

  it("serves status and manual sync through the API", async () => {
    const run = await h.ctx.call("post", "/api/sync").send({ itemId }).expect(200);
    expect(run.body.runs[0]).toMatchObject({ itemId, status: "success", trigger: "manual" });
    const status = await h.ctx.call("get", "/api/sync/status").expect(200);
    expect(status.body.items[0].lastRun.status).toBe("success");
    await h.ctx.call("post", "/api/sync").send({ itemId: "x" }).expect(400);
    await h.ctx.call("post", "/api/sync").send({ itemId: 9999 }).expect(404);
  });

  it("lists transactions newest first with pagination and totals", async () => {
    await h.sync.syncItem(itemId, "manual");
    const first = (await h.ctx.call("get", "/api/transactions?pageSize=10").expect(200)).body;
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(h.txCount());
    expect(first.page).toBe(1);
    const dates = first.items.map((t: { date: string }) => t.date);
    expect([...dates].sort().reverse()).toEqual(dates);

    const second = (await h.ctx.call("get", "/api/transactions?pageSize=10&page=2").expect(200))
      .body;
    expect(second.items[0].id).not.toBe(first.items[0].id);
    const last = (
      await h.ctx
        .call("get", `/api/transactions?pageSize=10&page=${Math.ceil(first.total / 10)}`)
        .expect(200)
    ).body;
    expect(last.items.length).toBeGreaterThan(0);
    expect(last.items.length).toBeLessThanOrEqual(10);
  });

  it("filters by account, date, pending state, and search text", async () => {
    await h.sync.syncItem(itemId, "manual");
    const card = h.ctx.db.select().from(accounts).where(eq(accounts.subtype, "credit card")).get()!;
    const byAccount = (
      await h.ctx.call("get", `/api/transactions?pageSize=200&accountId=${card.id}`).expect(200)
    ).body;
    expect(byAccount.items.length).toBeGreaterThan(0);
    expect(
      byAccount.items.every(
        (t: { accountId: number; accountName: string }) =>
          t.accountId === card.id && t.accountName === "Plaid Credit Card",
      ),
    ).toBe(true);

    const dated = (
      await h.ctx
        .call("get", "/api/transactions?pageSize=200&from=2026-08-01&to=2026-08-31")
        .expect(200)
    ).body;
    expect(
      dated.items.every((t: { date: string }) => t.date >= "2026-08-01" && t.date <= "2026-08-31"),
    ).toBe(true);

    const pending = (
      await h.ctx.call("get", "/api/transactions?pageSize=200&pending=true").expect(200)
    ).body;
    expect(pending.items.length).toBeGreaterThan(0);
    expect(pending.items.every((t: { pending: boolean }) => t.pending)).toBe(true);
    const posted = (
      await h.ctx.call("get", "/api/transactions?pageSize=200&pending=false").expect(200)
    ).body;
    expect(posted.items.every((t: { pending: boolean }) => !t.pending)).toBe(true);
    expect(pending.total + posted.total).toBe(h.txCount());

    const search = (await h.ctx.call("get", "/api/transactions?pageSize=200&q=amazon").expect(200))
      .body;
    expect(search.items.length).toBeGreaterThan(0);
    expect(
      search.items.every((t: { merchant: string; name: string }) =>
        /amazon/i.test(t.merchant + t.name),
      ),
    ).toBe(true);
  });

  it("treats % and _ in a search as plain characters", async () => {
    await h.sync.syncItem(itemId, "manual");
    const res = (await h.ctx.call("get", "/api/transactions?q=%25").expect(200)).body;
    expect(res.total).toBe(0);
    expect((await h.ctx.call("get", "/api/transactions?q=_").expect(200)).body.total).toBe(0);
  });

  it("shows the merchant, falling back to the description, and the account details", async () => {
    await h.sync.syncItem(itemId, "manual");
    const res = (await h.ctx.call("get", "/api/transactions?pageSize=200").expect(200)).body;
    const zelle = res.items.find((t: { name: string }) => t.name.startsWith("Zelle payment to"));
    expect(zelle.merchant).toBe(zelle.name); // no merchant name: the description is shown
    // Use an older month: the demo provider only adds merchant names to some transactions during
    // their first week, and which ones depends on the connection's random ID.
    const rent = res.items.find(
      (t: { name: string; date: string }) =>
        t.name.startsWith("OAK STREET") && t.date === "2026-08-01",
    );
    expect(rent).toMatchObject({
      merchant: "Oak Street Apartments",
      institutionName: "First Platypus Bank",
      accountName: "Plaid Checking",
      currency: "USD",
    });
    expect(rent.accountColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(rent.categoryPrimary).toBe("RENT_AND_UTILITIES");
    // The user's merchant name wins over the provider's.
    h.ctx.db
      .update(transactions)
      .set({ merchantNameUser: "My Landlord" })
      .where(eq(transactions.id, rent.id))
      .run();
    const after = (await h.ctx.call("get", "/api/transactions?q=oak").expect(200)).body.items;
    expect(after.find((t: { id: number }) => t.id === rent.id).merchant).toBe("My Landlord");
    // Searching also finds a transaction by the user's own merchant name.
    const byUserName = (await h.ctx.call("get", "/api/transactions?q=landlord").expect(200)).body;
    expect(byUserName.items.map((t: { id: number }) => t.id)).toEqual([rent.id]);
  });

  it("validates transaction queries", async () => {
    await h.ctx.call("get", "/api/transactions?page=0").expect(400);
    await h.ctx.call("get", "/api/transactions?pageSize=1000").expect(400);
    await h.ctx.call("get", "/api/transactions?from=yesterday").expect(400);
    await h.ctx.call("get", "/api/transactions?pending=maybe").expect(400);
  });

  it("deleting a connection deletes its transactions, snapshots, runs and limit history", async () => {
    await h.sync.syncItem(itemId, "manual");
    await h.ctx.call("delete", `/api/plaid/items/${itemId}`).expect(204);
    expect(h.txCount()).toBe(0);
    expect(h.ctx.db.select().from(balanceSnapshots).all()).toHaveLength(0);
    expect(h.ctx.db.select().from(creditLimitHistory).all()).toHaveLength(0);
    expect(h.ctx.db.select().from(syncRuns).all()).toHaveLength(0);
  });

  it("requires the API token for the new endpoints", async () => {
    const { default: request } = await import("supertest");
    for (const url of ["/api/sync/status", "/api/transactions", "/api/accounts/1/credit-limits"]) {
      await request(h.ctx.app).get(url).set("Host", "127.0.0.1:47998").expect(401);
    }
    await request(h.ctx.app).post("/api/sync").set("Host", "127.0.0.1:47998").expect(401);
  });
});
