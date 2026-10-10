import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "./db/client.js";
import { upsertTransaction } from "./services/transaction.service.js";
import type { GatewayTransaction } from "./plaid/gateway.js";
import {
  linkDemoBank,
  makeSyncHarness,
  MIGRATIONS,
  TEST_DB_KEY,
  truncatedMigrations,
} from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

interface Detail {
  merchant: string;
  name: string;
  amountMinor: number;
  paymentChannel: string | null;
  details: {
    datetime: string | null;
    authorizedDatetime: string | null;
    originalDescription: string | null;
    location: Record<string, unknown> | null;
    merchant: Record<string, unknown> | null;
    categoryConfidence: string | null;
    payment: Record<string, unknown> | null;
    counterparties: Array<Record<string, unknown>>;
  };
}

async function synced() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  const bank = await linkDemoBank(h.call);
  await h.sync.syncItem(bank.item.id, "manual");
  const items = (await h.call("get", "/api/transactions?pageSize=200").expect(200)).body
    .items as Detail[];
  return { h, items, itemId: bank.item.id as number };
}

describe("transaction details from the provider", () => {
  it("keeps the time of day, the bank's own wording, and the confidence of the category", async () => {
    const { items } = await synced();
    const t = items.find((x) => x.merchant === "Chipotle")!;
    expect(t.details.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(t.details.authorizedDatetime).toMatch(/T/);
    // The raw text differs from the cleaned-up merchant and the shown description.
    expect(t.details.originalDescription).toContain("CHIPOTLE");
    expect(t.details.originalDescription).not.toBe(t.name);
    expect(t.details.categoryConfidence).toBe("VERY_HIGH");
  });

  it("keeps the location of an in-store purchase, and none for an online one", async () => {
    const { items } = await synced();
    const inStore = items.find((x) => x.paymentChannel === "in store" && x.details.location)!;
    expect(inStore.details.location).toMatchObject({
      city: "Springfield",
      region: "IL",
      country: "US",
      postalCode: "62701",
    });
    expect(inStore.details.location!["lat"]).toBeCloseTo(39.7817, 3);
    expect(inStore.details.location!["storeNumber"]).toEqual(expect.any(String));
    const online = items.find((x) => x.paymentChannel === "online")!;
    expect(online.details.location).toBeNull();
  });

  it("keeps merchant details, payment details, and every counterparty", async () => {
    const { items } = await synced();
    const t = items.find((x) => x.merchant === "Whole Foods Market")!;
    expect(t.details.merchant).toMatchObject({
      entityId: expect.stringMatching(/^entity-fake~/),
      categoryCode: expect.stringMatching(/^\d{4}$/),
      website: "wholefoodsmarket.com",
    });
    expect(t.details.counterparties).toEqual([
      expect.objectContaining({
        name: "Whole Foods Market",
        type: "merchant",
        confidenceLevel: "VERY_HIGH",
        website: "wholefoodsmarket.com",
      }),
    ]);
    const paid = items.find((x) => x.details.payment?.["method"] === "ACH")!;
    expect(paid.details.payment).toMatchObject({
      method: "ACH",
      processor: "Demo Payments",
      reference: expect.stringMatching(/^REF/),
    });
  });
});

describe("filling the new fields for transactions already stored", () => {
  /** A bare transaction as the previous version stored it: none of the new fields. */
  const bare = (over: Partial<GatewayTransaction> = {}): GatewayTransaction => ({
    transactionId: "txn-old-1",
    accountId: "acct-1",
    pendingTransactionId: null,
    date: "2026-09-01",
    authorizedDate: "2026-09-01",
    name: "Old Cafe",
    merchantName: "Old Cafe",
    amount: 4.5,
    currency: "USD",
    pending: false,
    paymentChannel: "in store",
    categoryPrimary: "FOOD_AND_DRINK",
    categoryDetailed: "FOOD_AND_DRINK_COFFEE",
    counterparties: [],
    paymentPayee: null,
    paymentPayer: null,
    ...over,
  });

  it("updates a stored transaction in place, and never touches what the user edited", async () => {
    const { h, itemId } = await synced();
    // A row the provider has already enriched (some recent ones have no merchant yet).
    const first = (
      (await h.call("get", "/api/transactions?pageSize=50&q=chipotle").expect(200)).body
        .items as Array<{
        id: number;
        providerMerchant: string;
        details: { counterparties: unknown[] };
      }>
    ).find((t) => t.providerMerchant === "Chipotle" && t.details.counterparties.length > 0)!;
    // The user's own edits.
    await h
      .call("patch", `/api/transactions/${first.id}`)
      .send({ merchant: "My Lunch Spot", notes: "with Sam" })
      .expect(200);
    const before = (await h.call("get", `/api/transactions/${first.id}`).expect(200)).body;

    // Wipe the new fields as if it had been stored by the previous version, then sync from scratch.
    h.sqlite
      .prepare(
        "UPDATE transactions SET datetime = NULL, original_description = NULL, location_city = NULL, merchant_entity_id = NULL, payment_method = NULL, counterparties_json = NULL, category_confidence = NULL",
      )
      .run();
    h.sqlite.prepare("UPDATE plaid_items SET sync_cursor = NULL").run();
    await h.sync.syncItem(itemId, "manual");

    const after = (await h.call("get", `/api/transactions/${first.id}`).expect(200)).body;
    expect(after.id).toBe(first.id);
    expect(after.details.originalDescription).not.toBeNull();
    expect(after.details.datetime).not.toBeNull();
    expect(after.details.categoryConfidence).toBe("VERY_HIGH");
    expect(after.details.counterparties.length).toBeGreaterThan(0);
    // Still the user's wording and note.
    expect(after).toMatchObject({ merchant: "My Lunch Spot", notes: "with Sam" });
    expect(after.amountMinor).toBe(before.amountMinor);
  });

  it("does not duplicate anything on a full re-sync", async () => {
    const { h, itemId } = await synced();
    const count = async () =>
      (await h.call("get", "/api/transactions?pageSize=1").expect(200)).body.total as number;
    const before = await count();
    h.sqlite.prepare("UPDATE plaid_items SET sync_cursor = NULL").run();
    await h.sync.syncItem(itemId, "manual");
    expect(await count()).toBe(before);
  });

  it("stores the new fields from a transaction that has them, and replaces them on a change", () => {
    const { db, sqlite } = createDb({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pf-td-")),
      key: TEST_DB_KEY,
    });
    cleanups.push(() => sqlite.close());
    runMigrations(db, MIGRATIONS);
    sqlite.exec(
      "INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES (1, 'A', 'depository', 'USD', 'x', 'x')",
    );
    upsertTransaction(
      db,
      1,
      bare({
        datetime: "2026-09-01T14:30:00Z",
        originalDescription: "OLD CAFE #12 SPRINGFIELD IL",
        location: {
          address: "1 Main St",
          city: "Springfield",
          region: "IL",
          postalCode: "62701",
          country: "US",
          lat: 39.78,
          lon: -89.65,
          storeNumber: "12",
        },
        payment: {
          method: "Card",
          processor: null,
          reference: "R1",
          reason: null,
          byOrderOf: null,
          ppdId: null,
        },
        categoryConfidence: "HIGH",
        counterparties: [
          { name: "Old Cafe", type: "merchant", entityId: "e1", confidenceLevel: "HIGH" },
          { name: "Square", type: "payment_terminal" },
        ],
      }),
      "t1",
    );
    const row = () =>
      sqlite
        .prepare("SELECT * FROM transactions WHERE plaid_transaction_id = 'txn-old-1'")
        .get() as Record<string, unknown>;
    expect(row()).toMatchObject({
      datetime: "2026-09-01T14:30:00Z",
      original_description: "OLD CAFE #12 SPRINGFIELD IL",
      location_city: "Springfield",
      location_store_number: "12",
      payment_method: "Card",
      category_confidence: "HIGH",
      counterparty_name: "Old Cafe",
    });
    expect(JSON.parse(row()["counterparties_json"] as string)).toHaveLength(2);

    // The provider later sends a corrected record: the stored fields follow it.
    upsertTransaction(db, 1, bare({ categoryConfidence: "LOW", counterparties: [] }), "t2");
    expect(row()).toMatchObject({ category_confidence: "LOW", location_city: null });
    expect(row()["counterparties_json"]).toBeNull();
  });
});

describe("upgrading to the version that stores these fields", () => {
  it("starts every connection over at its next sync, and keeps the rest", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "pf-up-"));
    const old = truncatedMigrations(11); // everything before 0011
    cleanups.push(() => {
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
    });
    const { db, sqlite } = createDb({ dataDir: data, key: TEST_DB_KEY });
    runMigrations(db, old);
    sqlite.exec(`
      INSERT INTO plaid_items (plaid_item_id, environment, institution_name, access_token_encrypted, status, days_requested, sync_cursor, last_successful_sync_at, created_at, updated_at)
        VALUES ('item-1', 'sandbox', 'Bank', 'enc', 'active', 730, 'cursor-abc', '2026-09-01T00:00:00Z', 'x', 'x');
      INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES (1, 'A', 'depository', 'USD', 'x', 'x');
      INSERT INTO transactions (account_id, date, name, amount_minor, currency, created_at, updated_at)
        VALUES (1, '2026-09-01', 'Kept', 100, 'USD', 'x', 'x');
    `);
    runMigrations(db, MIGRATIONS);
    expect(
      sqlite.prepare("SELECT sync_cursor, status, last_successful_sync_at FROM plaid_items").get(),
    ).toEqual({
      sync_cursor: null,
      status: "active",
      last_successful_sync_at: "2026-09-01T00:00:00Z",
    });
    expect(
      sqlite
        .prepare("SELECT name, datetime, location_city, counterparties_json FROM transactions")
        .get(),
    ).toEqual({ name: "Kept", datetime: null, location_city: null, counterparties_json: null });
    sqlite.close();
  });
});
