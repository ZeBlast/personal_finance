import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations } from "./db/client.js";
import { borrowConnections, previewBorrow } from "./services/borrow.service.js";
import { createCipher, deriveDatabaseKey } from "./services/crypto.js";
import {
  linkDemoBank,
  makeSyncHarness,
  makeTestApp,
  MIGRATIONS,
  openDatabaseFile,
} from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

const REAL_MASTER = "ef".repeat(32);

/** A copy of "the real app's" database, as a backup of it would hold it, with two real connections. */
function realBackup(options: { master?: string; extra?: string } = {}): string {
  const master = options.master ?? REAL_MASTER;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-real-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { db, sqlite, file } = createDb({ dataDir: dir, key: deriveDatabaseKey(master) });
  runMigrations(db, MIGRATIONS);
  const real = createCipher(master);
  const insert = sqlite.prepare(
    `INSERT INTO plaid_items (plaid_item_id, environment, institution_id, institution_name, access_token_encrypted, status, days_requested, sync_cursor, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 730, 'real-cursor', 'x', 'x')`,
  );
  insert.run(
    "item-real-1",
    "production",
    "ins_1",
    "Real Bank",
    real.encrypt("access-production-111", "item-real-1"),
    "active",
  );
  insert.run(
    "item-real-2",
    "production",
    "ins_2",
    "Real Brokerage",
    real.encrypt("access-production-222", "item-real-2"),
    "login_required",
  );
  insert.run(
    "item-demo-1",
    "fake",
    "ins_f",
    "Demo Bank",
    real.encrypt("access-fake-1", "item-demo-1"),
    "active",
  );
  insert.run(
    "item-sb-1",
    "sandbox",
    "ins_s",
    "Sandbox Bank",
    real.encrypt("access-sandbox-1", "item-sb-1"),
    "active",
  );
  const cred = sqlite.prepare(
    "INSERT INTO credentials (key, value_encrypted, updated_at) VALUES (?, ?, 'x')",
  );
  cred.run(
    "plaid.production.client_id",
    real.encrypt("real-client-id", "plaid.production.client_id"),
  );
  cred.run("plaid.production.secret", real.encrypt("real-secret-value", "plaid.production.secret"));
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  sqlite.close();
  void options.extra;
  return file;
}

const hashOf = (file: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function dev() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const ownFile = path.join((t.db as unknown as { $client: { name: string } }).$client.name);
  return { ...t, ownFile };
}

const rows = (t: ReturnType<typeof dev>) =>
  t.sqlite.prepare("SELECT * FROM plaid_items ORDER BY id").all() as Array<Record<string, unknown>>;

describe("borrowing the real app's connections", () => {
  it("copies production connections in, marked as borrowed, with their tokens readable here", () => {
    const t = dev();
    const result = borrowConnections(t.db, t.cipher, {
      sourceFile: realBackup(),
      sourceMasterKey: REAL_MASTER,
      environments: ["production"],
    });
    expect(result.borrowed).toEqual([
      { institutionName: "Real Bank", environment: "production" },
      { institutionName: "Real Brokerage", environment: "production" },
    ]);
    const items = rows(t);
    expect(items).toHaveLength(2);
    for (const row of items) {
      expect(row).toMatchObject({ borrowed: 1, status: "active", sync_cursor: null });
    }
    // The token is saved under THIS install's key, and is the same token.
    const first = items[0]!;
    expect(t.cipher.decrypt(first["access_token_encrypted"] as string, "item-real-1")).toBe(
      "access-production-111",
    );
    expect(first["access_token_encrypted"]).not.toContain("access-production");
  });

  it("brings the Plaid keys the connections need, and nothing for other environments", () => {
    const t = dev();
    const result = borrowConnections(t.db, t.cipher, {
      sourceFile: realBackup(),
      sourceMasterKey: REAL_MASTER,
      environments: ["production"],
    });
    expect(result.credentials).toEqual({ copied: ["production"], kept: [] });
    const get = (key: string) =>
      t.cipher.decrypt(
        (
          t.sqlite
            .prepare("SELECT value_encrypted AS v FROM credentials WHERE key = ?")
            .get(key) as { v: string }
        ).v,
        key,
      );
    expect(get("plaid.production.client_id")).toBe("real-client-id");
    expect(get("plaid.production.secret")).toBe("real-secret-value");
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 2 });
  });

  it("leaves out the demo bank and the sandbox one unless asked, and never one it already has", () => {
    const t = dev();
    const source = realBackup();
    const first = previewBorrow(t.db, {
      sourceFile: source,
      sourceMasterKey: REAL_MASTER,
      environments: ["production"],
    });
    expect(first.map((c) => [c.institutionName, c.skip])).toEqual([
      ["Real Bank", null],
      ["Real Brokerage", null],
      ["Demo Bank", "demo"],
      ["Sandbox Bank", "not_in_environment"],
    ]);
    // The preview carries no secret of any kind.
    expect(JSON.stringify(first)).not.toMatch(/access|secret|token/i);
    borrowConnections(t.db, t.cipher, {
      sourceFile: source,
      sourceMasterKey: REAL_MASTER,
      environments: ["production"],
    });
    const again = borrowConnections(t.db, t.cipher, {
      sourceFile: source,
      sourceMasterKey: REAL_MASTER,
      environments: ["production"],
    });
    expect(again.borrowed).toEqual([]);
    expect(again.skipped.filter((s) => s.skip === "already_here")).toHaveLength(2);
    expect(rows(t)).toHaveLength(2);
  });

  it("keeps this install's own Plaid keys unless told to replace them", () => {
    const t = dev();
    t.sqlite
      .prepare("INSERT INTO credentials (key, value_encrypted, updated_at) VALUES (?, ?, 'x')")
      .run(
        "plaid.production.client_id",
        t.cipher.encrypt("my-own-id", "plaid.production.client_id"),
      );
    t.sqlite
      .prepare("INSERT INTO credentials (key, value_encrypted, updated_at) VALUES (?, ?, 'x')")
      .run("plaid.production.secret", t.cipher.encrypt("my-own-secret", "plaid.production.secret"));
    const source = realBackup();
    const kept = borrowConnections(t.db, t.cipher, {
      sourceFile: source,
      sourceMasterKey: REAL_MASTER,
      environments: ["production"],
    });
    expect(kept.credentials).toEqual({ copied: [], kept: ["production"] });
    const read = () =>
      t.cipher.decrypt(
        (
          t.sqlite
            .prepare(
              "SELECT value_encrypted AS v FROM credentials WHERE key = 'plaid.production.secret'",
            )
            .get() as { v: string }
        ).v,
        "plaid.production.secret",
      );
    expect(read()).toBe("my-own-secret");
    // Replacing is deliberate.
    t.sqlite.prepare("DELETE FROM plaid_items").run();
    const replaced = borrowConnections(t.db, t.cipher, {
      sourceFile: source,
      sourceMasterKey: REAL_MASTER,
      environments: ["production"],
      replaceCredentials: true,
    });
    expect(replaced.credentials.copied).toEqual(["production"]);
    expect(read()).toBe("real-secret-value");
  });

  it("refuses a wrong or malformed recovery key, and changes nothing", () => {
    const t = dev();
    const source = realBackup();
    for (const key of ["cd".repeat(32), "not-a-key"]) {
      expect(() =>
        borrowConnections(t.db, t.cipher, { sourceFile: source, sourceMasterKey: key }),
      ).toThrow(/recovery key/i);
    }
    expect(rows(t)).toHaveLength(0);
  });

  it("changes nothing when one connection cannot be read, rather than borrowing half", () => {
    const t = dev();
    // A backup whose tokens were saved under a different key than the one it opens with.
    const source = realBackup();
    const live = openDatabaseFile(source, deriveDatabaseKey(REAL_MASTER));
    live
      .prepare(
        "UPDATE plaid_items SET access_token_encrypted = ? WHERE plaid_item_id = 'item-real-2'",
      )
      .run(createCipher("12".repeat(32)).encrypt("x", "item-real-2"));
    live.close();
    expect(() =>
      borrowConnections(t.db, t.cipher, {
        sourceFile: source,
        sourceMasterKey: REAL_MASTER,
        environments: ["production"],
      }),
    ).toThrow(/could not be read/);
    expect(rows(t)).toHaveLength(0);
  });

  it("never writes to the real app's database", () => {
    const t = dev();
    const source = realBackup();
    const before = hashOf(source);
    const beforeFiles = fs.readdirSync(path.dirname(source)).sort();
    borrowConnections(t.db, t.cipher, { sourceFile: source, sourceMasterKey: REAL_MASTER });
    previewBorrow(t.db, { sourceFile: source, sourceMasterKey: REAL_MASTER });
    expect(hashOf(source)).toBe(before);
    // Nothing was created beside it either (not even the helper files opening a database can leave).
    expect(fs.readdirSync(path.dirname(source)).sort()).toEqual(beforeFiles);
  });

  it("refuses to borrow from its own database", () => {
    const t = dev();
    expect(() =>
      borrowConnections(t.db, t.cipher, {
        sourceFile: t.ownFile,
        sourceMasterKey: REAL_MASTER,
        ownFile: t.ownFile,
      }),
    ).toThrow(/own database/);
  });

  it("can borrow from a backup an earlier version made as an ordinary file", () => {
    const t = dev();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-old-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "old.db");
    const real = createCipher(REAL_MASTER);
    const plain = openDatabaseFile(file, null);
    plain.exec(
      "CREATE TABLE plaid_items (id INTEGER PRIMARY KEY, plaid_item_id TEXT, environment TEXT, institution_id TEXT, institution_name TEXT, access_token_encrypted TEXT, status TEXT, days_requested INTEGER); CREATE TABLE credentials (key TEXT PRIMARY KEY, value_encrypted TEXT, updated_at TEXT)",
    );
    plain
      .prepare(
        "INSERT INTO plaid_items VALUES (1, 'item-old', 'production', 'i', 'Old Bank', ?, 'active', 730)",
      )
      .run(real.encrypt("access-old", "item-old"));
    plain.close();
    const result = borrowConnections(t.db, t.cipher, {
      sourceFile: file,
      sourceMasterKey: REAL_MASTER,
    });
    expect(result.borrowed).toEqual([{ institutionName: "Old Bank", environment: "production" }]);
  });
});

describe("a borrowed connection can never change the real one", () => {
  async function borrowedHarness() {
    const h = makeSyncHarness();
    cleanups.push(h.cleanup);
    const bank = await linkDemoBank(h.call);
    h.sqlite.prepare("UPDATE plaid_items SET borrowed = 1").run();
    const spies = {
      removeItem: vi.spyOn(h.gateway, "removeItem"),
      createLinkToken: vi.spyOn(h.gateway, "createLinkToken"),
      completeReauthentication: vi.spyOn(h.gateway, "completeReauthentication"),
      syncTransactions: vi.spyOn(h.gateway, "syncTransactions"),
      getItem: vi.spyOn(h.gateway, "getItem"),
    };
    return { h, id: bank.item.id as number, spies };
  }

  it("deleting it removes only the local copy, and never tells Plaid", async () => {
    const { h, id, spies } = await borrowedHarness();
    await h.call("delete", `/api/plaid/items/${id}`).expect(204);
    // Even the "force" form, which skips Plaid's answer, never calls it.
    expect(spies.removeItem).not.toHaveBeenCalled();
    expect((await h.call("get", "/api/plaid/items").expect(200)).body).toEqual([]);
    expect((await h.call("get", "/api/accounts").expect(200)).body).toEqual([]);
  });

  it("refuses to sign it in again or repair it", async () => {
    const { h, id, spies } = await borrowedHarness();
    const link = await h.call("post", `/api/plaid/items/${id}/link-token`).expect(409);
    expect(link.body.error).toBe("borrowed_connection");
    const reauth = await h
      .call("post", `/api/plaid/items/${id}/reauthenticated`)
      .send({ publicToken: "public-x" })
      .expect(409);
    expect(reauth.body.error).toBe("borrowed_connection");
    expect(spies.createLinkToken).not.toHaveBeenCalled();
    expect(spies.completeReauthentication).not.toHaveBeenCalled();
  });

  it("may still be checked, and shows that it is borrowed", async () => {
    const { h, id, spies } = await borrowedHarness();
    const res = await h.call("post", `/api/plaid/items/${id}/check`).expect(200);
    expect(res.body.borrowed).toBe(true);
    expect(spies.getItem).toHaveBeenCalled();
  });

  it("is left alone by the launch sync and the timer, and read only when asked", async () => {
    const { h, spies } = await borrowedHarness();
    const launch = await h.sync.runLaunchSync();
    expect(launch.runs).toEqual([]);
    expect(launch.skipped).toMatchObject([{ reason: "borrowed" }]);
    expect((await h.sync.runIntervalTick()).runs).toEqual([]);
    expect(spies.syncTransactions).not.toHaveBeenCalled();

    const manual = await h.call("post", "/api/sync").send({}).expect(200);
    expect(manual.body.runs).toHaveLength(1);
    expect(spies.syncTransactions).toHaveBeenCalled();
    // Reading is all it ever did to the connection.
    expect(spies.removeItem).not.toHaveBeenCalled();
  });
});
