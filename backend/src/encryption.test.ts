import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  DatabaseKeyError,
  DB_FILE_NAME,
  encryptExistingBackups,
  isPlaintextDatabase,
  runMigrations,
} from "./db/client.js";
import {
  applyPendingRestore,
  createBackup,
  pendingRestore,
  checkBackupFile,
} from "./services/backup.service.js";
import { deriveDatabaseKey } from "./services/crypto.js";
import {
  makeTestApp,
  MIGRATIONS,
  openDatabaseFile,
  TEST_DB_KEY,
  TEST_KEY,
} from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-enc-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const containsText = (file: string, text: string): boolean =>
  fs.readFileSync(file).includes(Buffer.from(text));

describe("database key", () => {
  it("is derived from the master key, differs from it, and is stable", () => {
    const key = deriveDatabaseKey(TEST_KEY);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(TEST_KEY);
    expect(deriveDatabaseKey(TEST_KEY)).toBe(key);
    expect(deriveDatabaseKey("ab".repeat(32))).not.toBe(key);
    expect(() => deriveDatabaseKey("short")).toThrow();
  });
});

describe("the database file on disk", () => {
  it("holds no readable data and has no SQLite header", () => {
    const dir = tempDir();
    const { db, sqlite, file } = createDb({ dataDir: dir, key: TEST_DB_KEY });
    runMigrations(db, MIGRATIONS);
    sqlite.exec(
      "INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('Distinctive Account Name', 'depository', 'USD', 'x', 'x')",
    );
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.close();
    expect(isPlaintextDatabase(file)).toBe(false);
    expect(containsText(file, "Distinctive Account Name")).toBe(false);
    expect(containsText(file, "SQLite format 3")).toBe(false);
    // Not even the table names are readable.
    expect(containsText(file, "transactions")).toBe(false);
  });

  it("reopens with the right key and keeps its data", () => {
    const dir = tempDir();
    const first = createDb({ dataDir: dir, key: TEST_DB_KEY });
    runMigrations(first.db, MIGRATIONS);
    first.sqlite.exec(
      "INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('Kept', 'depository', 'USD', 'x', 'x')",
    );
    first.sqlite.close();
    const again = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(again.sqlite.prepare("SELECT name FROM accounts").all()).toEqual([{ name: "Kept" }]);
    again.sqlite.close();
  });

  it("refuses a wrong key without touching the file", () => {
    const dir = tempDir();
    const first = createDb({ dataDir: dir, key: TEST_DB_KEY });
    runMigrations(first.db, MIGRATIONS);
    first.sqlite.close();
    const file = path.join(dir, DB_FILE_NAME);
    const before = fs.readFileSync(file);
    expect(() => createDb({ dataDir: dir, key: deriveDatabaseKey("ab".repeat(32)) })).toThrow(
      DatabaseKeyError,
    );
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("cannot be opened as an ordinary database", () => {
    const dir = tempDir();
    const first = createDb({ dataDir: dir, key: TEST_DB_KEY });
    runMigrations(first.db, MIGRATIONS);
    first.sqlite.close();
    const plain = openDatabaseFile(path.join(dir, DB_FILE_NAME), null, true);
    expect(() => plain.prepare("SELECT * FROM accounts").all()).toThrow(/not a database/);
    plain.close();
  });
});

describe("encrypting a database an earlier version left readable", () => {
  /** A plaintext database as the previous version of the app wrote it, in WAL mode with data. */
  function plaintextDatabase(dir: string): string {
    const file = path.join(dir, DB_FILE_NAME);
    const old = openDatabaseFile(file, null);
    old.pragma("journal_mode = WAL");
    old.pragma("wal_autocheckpoint = 0");
    old.exec(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE transactions (id INTEGER, name TEXT)",
    );
    old.exec("INSERT INTO accounts (name) VALUES ('Old Checking Account')");
    old.exec("INSERT INTO transactions (name) VALUES ('CHIPOTLE 2041'), ('ZELLE TO JANE')");
    // Deliberately closed with its newest rows still only in the write-ahead log.
    fs.copyFileSync(file, `${file}.snapshot`);
    fs.copyFileSync(`${file}-wal`, `${file}.snapshot-wal`);
    old.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    fs.renameSync(`${file}.snapshot`, file);
    fs.renameSync(`${file}.snapshot-wal`, `${file}-wal`);
    return file;
  }

  it("encrypts it in place, keeping every row, and leaves no readable copy behind", () => {
    const dir = tempDir();
    const file = plaintextDatabase(dir);
    expect(isPlaintextDatabase(file)).toBe(true);

    const { sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(sqlite.prepare("SELECT name FROM accounts").all()).toEqual([
      { name: "Old Checking Account" },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 2 });
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.close();

    expect(isPlaintextDatabase(file)).toBe(false);
    expect(containsText(file, "CHIPOTLE")).toBe(false);
    expect(containsText(file, "Old Checking Account")).toBe(false);
    // No plaintext copy or log is left in the folder.
    for (const name of fs.readdirSync(dir)) {
      expect(containsText(path.join(dir, name), "CHIPOTLE"), name).toBe(false);
    }
    expect(fs.existsSync(`${file}.before-encryption`)).toBe(false);
  });

  it("refuses a malformed key before touching the file", () => {
    const dir = tempDir();
    const file = plaintextDatabase(dir);
    expect(() => createDb({ dataDir: dir, key: "not-a-valid-key" })).toThrow(/64 hex/);
    // The data is still there, readable, and not converted.
    expect(isPlaintextDatabase(file)).toBe(true);
    const check = openDatabaseFile(file, null, true);
    expect(check.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 2 });
    check.close();
  });

  it("picks the original back up after a conversion that was cut short", () => {
    const dir = tempDir();
    const file = plaintextDatabase(dir);
    // As if the app died after keeping its copy but before the encrypted file was complete.
    const keep = openDatabaseFile(file, null);
    keep.pragma("wal_checkpoint(TRUNCATE)");
    keep.pragma("journal_mode = DELETE");
    keep.close();
    fs.copyFileSync(file, `${file}.before-encryption`);
    fs.writeFileSync(file, Buffer.alloc(8192, 7)); // not a database any more
    const { sqlite } = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 2 });
    sqlite.close();
    expect(isPlaintextDatabase(file)).toBe(false);
    expect(fs.existsSync(`${file}.before-encryption`)).toBe(false);
  });
});

describe("backups", () => {
  it("are encrypted and restore into an encrypted database", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    t.sqlite.exec(
      "INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('Distinctive Account Name', 'depository', 'USD', 'x', 'x')",
    );
    const dir = path.dirname((t.db as unknown as { $client: { name: string } }).$client.name);
    const made = await createBackup(t.db, dir, "manual");
    const file = path.join(dir, "backups", made.name);
    expect(isPlaintextDatabase(file)).toBe(false);
    expect(containsText(file, "Distinctive Account Name")).toBe(false);

    await t.call("post", `/api/backups/${made.name}/restore`).expect(200);
    t.sqlite.close();
    expect(applyPendingRestore(dir)).not.toBeNull();
    const live = path.join(dir, DB_FILE_NAME);
    expect(isPlaintextDatabase(live)).toBe(false);
    const reopened = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(reopened.sqlite.prepare("SELECT name FROM accounts").all()).toContainEqual({
      name: "Distinctive Account Name",
    });
    reopened.sqlite.close();
  });

  it("from before encryption still restore, and come back encrypted", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const dir = path.dirname((t.db as unknown as { $client: { name: string } }).$client.name);
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
    const old = path.join(dir, "backups", "pf-manual-20260101-000001.db");
    const plain = openDatabaseFile(old, null);
    plain.exec(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE transactions (id INTEGER); CREATE TABLE app_settings (key TEXT); INSERT INTO accounts (name) VALUES ('From an older version')",
    );
    plain.close();
    expect(isPlaintextDatabase(old)).toBe(true);

    await t.call("post", "/api/backups/pf-manual-20260101-000001.db/restore").expect(200);
    t.sqlite.close();
    applyPendingRestore(dir);
    // The staged copy is written with this computer's key, whatever the backup used.
    expect(isPlaintextDatabase(path.join(dir, DB_FILE_NAME))).toBe(false);
    const reopened = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(reopened.sqlite.prepare("SELECT name FROM accounts").all()).toEqual([
      { name: "From an older version" },
    ]);
    reopened.sqlite.close();
  });

  it("an earlier version made as ordinary files are encrypted in place at startup", () => {
    const dir = tempDir();
    const backups = path.join(dir, "backups");
    fs.mkdirSync(backups);
    const file = path.join(backups, "pf-auto-20260101-000001.db");
    const plain = openDatabaseFile(file, null);
    plain.exec("CREATE TABLE accounts (name TEXT); INSERT INTO accounts VALUES ('Visible Name')");
    plain.close();
    expect(encryptExistingBackups(backups, TEST_DB_KEY)).toBe(1);
    expect(isPlaintextDatabase(file)).toBe(false);
    expect(containsText(file, "Visible Name")).toBe(false);
    const reopened = openDatabaseFile(file);
    expect(reopened.prepare("SELECT name FROM accounts").all()).toEqual([{ name: "Visible Name" }]);
    reopened.close();
    // Running it again has nothing left to do.
    expect(encryptExistingBackups(backups, TEST_DB_KEY)).toBe(0);
  });

  it("from another computer need that computer's recovery key to restore", async () => {
    const other = deriveDatabaseKey("ab".repeat(32));
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const dir = path.dirname((t.db as unknown as { $client: { name: string } }).$client.name);
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
    const name = "pf-manual-20260101-000001.db";
    const foreign = openDatabaseFile(path.join(dir, "backups", name), other);
    foreign.exec(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE transactions (id INTEGER); CREATE TABLE app_settings (key TEXT); INSERT INTO accounts (name) VALUES ('From my old laptop')",
    );
    foreign.close();

    // Without the key it is refused, with a message that points at the recovery key.
    const refused = await t.call("post", `/api/backups/${name}/restore`).expect(409);
    expect(refused.body.error).toBe("backup_needs_key");
    // The wrong key is refused too.
    await t
      .call("post", `/api/backups/${name}/restore`)
      .send({ recoveryKey: "cd".repeat(32) })
      .expect(409);
    await t
      .call("post", `/api/backups/${name}/restore`)
      .send({ recoveryKey: "nonsense" })
      .expect(400);
    expect(pendingRestore(dir)).toBeNull();

    await t
      .call("post", `/api/backups/${name}/restore`)
      .send({ recoveryKey: "ab".repeat(32) })
      .expect(200);
    t.sqlite.close();
    applyPendingRestore(dir);
    // Now it opens with THIS computer's key.
    const reopened = createDb({ dataDir: dir, key: TEST_DB_KEY });
    expect(reopened.sqlite.prepare("SELECT name FROM accounts").all()).toEqual([
      { name: "From my old laptop" },
    ]);
    reopened.sqlite.close();
  });

  it("checkBackupFile reports a file it cannot open instead of throwing", () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const junk = path.join(os.tmpdir(), `pf-junk-${process.pid}.db`);
    fs.writeFileSync(junk, Buffer.alloc(4096, 3));
    cleanups.push(() => fs.rmSync(junk, { force: true }));
    expect(checkBackupFile(t.db, junk, 1)).toMatchObject({ ok: false, needsKey: true });
  });
});

describe("the recovery key", () => {
  it("is shown on request, never cached, and the app reports the file as encrypted", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const res = await t.call("post", "/api/data/recovery-key").expect(200);
    expect(res.body).toEqual({ recoveryKey: TEST_KEY });
    expect(res.headers["cache-control"]).toBe("no-store");
    // A GET (a link or a prefetch) never returns it.
    const get = await t.call("get", "/api/data/recovery-key");
    expect(JSON.stringify(get.body)).not.toContain(TEST_KEY);
    expect((await t.call("get", "/api/data/encryption").expect(200)).body).toEqual({
      encrypted: true,
      recoveryKeyAvailable: true,
    });
  });
});
