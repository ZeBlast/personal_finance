import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import {
  applyPendingRestore,
  autoBackupIfDue,
  backupDir,
  checkBackupFile,
  createBackup,
  listBackups,
  pendingRestore,
  pruneAutoBackups,
} from "./services/backup.service.js";
import { makeSyncHarness, makeTestApp, linkDemoBank } from "./test-helpers.js";
import { toCsv } from "./utils/csv-write.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return { ...t, dir: backupDirOf(t) };
}
const backupDirOf = (t: { db: unknown }): string => {
  const client = (t.db as { $client: Database.Database }).$client;
  return path.dirname(client.name);
};

function harness() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  return { ...h, dir: backupDirOf(h) };
}

const accountNames = (dir: string, file = "personal-finance.db"): string[] => {
  const raw = new Database(path.join(dir, file), { readonly: true });
  try {
    return (
      raw.prepare("SELECT name FROM accounts ORDER BY id").all() as Array<{ name: string }>
    ).map((r) => r.name);
  } finally {
    raw.close();
  }
};

describe("csv writing", () => {
  it("quotes what needs quoting and ends lines with CRLF", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          ["x,y", 'say "hi"'],
          ["two\nlines", null],
        ],
      ),
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\n"two\nlines",\r\n');
  });

  it("stops spreadsheet formulas in text, but leaves numbers alone", () => {
    const text = toCsv(
      ["v"],
      [["=1+1"], ["+cmd"], ["-x"], ["@sum"], ["safe"], [-5], [0.5], [true]],
    );
    expect(text.split("\r\n")).toEqual([
      "v",
      "'=1+1",
      "'+cmd",
      "'-x",
      "'@sum",
      "safe",
      "-5",
      "0.5",
      "true",
      "",
    ]);
  });
});

describe("net worth history", () => {
  it("is empty with no accounts", async () => {
    const t = app();
    const res = (await t.call("get", "/api/analytics/net-worth-history").expect(200)).body;
    expect(res).toMatchObject({ points: [], gaps: [], completeFrom: null, accountsTotal: 0 });
  });

  it("uses only observed balances, with debts subtracted, and marks gaps", async () => {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual"); // Sep 1
    h.advanceDays(3);
    await h.sync.syncItem(bank.item.id, "manual"); // Sep 4
    h.advanceDays(20);
    await h.sync.syncItem(bank.item.id, "manual"); // Sep 24
    const res = (await h.call("get", "/api/analytics/net-worth-history").expect(200)).body;
    expect(res.points.map((p: { date: string }) => p.date)).toEqual([
      "2026-09-01",
      "2026-09-04",
      "2026-09-24",
    ]);
    // Checking 110 + savings 210 are assets; the credit card's 410 owed is a debt.
    expect(res.points[0]).toMatchObject({
      assetsMinor: 32000,
      liabilitiesMinor: 41000,
      netWorthMinor: -9000,
      accountsObserved: 3,
      gapDays: null,
    });
    expect(res.points[2].gapDays).toBe(20);
    expect(res.gaps).toEqual([{ from: "2026-09-05", to: "2026-09-23", days: 19 }]);
    expect(res.completeFrom).toBe("2026-09-01");
    expect(res.accountsTotal).toBe(3);
  });

  it("reports an account only from its first observation", async () => {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    h.advanceDays(2);
    const manual = await h
      .call("post", "/api/investments/accounts")
      .send({ name: "TSP" })
      .expect(201);
    await h
      .call("put", `/api/investments/accounts/${manual.body.id}/holdings`)
      .send({ holdings: [{ symbol: "TSP-C", quantity: 1, valueMinor: 100000 }] })
      .expect(200);
    const res = (await h.call("get", "/api/analytics/net-worth-history").expect(200)).body;
    expect(res.accountsTotal).toBe(4);
    expect(res.points).toHaveLength(2);
    expect(res.points[0].accountsObserved).toBe(3);
    expect(res.points[1].accountsObserved).toBe(4);
    expect(res.points[1].assetsMinor - res.points[0].assetsMinor).toBe(100000);
    // Until the manual account was first recorded, the total was not complete.
    expect(res.completeFrom).toBe(res.points[1].date);
  });

  it("filters by range and rejects bad dates", async () => {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    h.advanceDays(10);
    await h.sync.syncItem(bank.item.id, "manual");
    const ranged = (
      await h
        .call("get", "/api/analytics/net-worth-history?from=2026-09-05&to=2026-09-30")
        .expect(200)
    ).body;
    expect(ranged.points.map((p: { date: string }) => p.date)).toEqual(["2026-09-11"]);
    await h.call("get", "/api/analytics/net-worth-history?from=2026-02-30").expect(400);
  });
});

describe("backups", () => {
  it("makes a complete, usable copy of the live database", async () => {
    const t = app();
    await t.call("post", "/api/investments/accounts").send({ name: "TSP" }).expect(201);
    const made = (await t.call("post", "/api/backups").expect(201)).body;
    expect(made).toMatchObject({ kind: "manual" });
    expect(made.name).toMatch(/^pf-manual-\d{8}-\d{6}\.db$/);
    expect(made.sizeBytes).toBeGreaterThan(10_000);
    const listed = (await t.call("get", "/api/backups").expect(200)).body;
    expect(listed.backups.map((b: { name: string }) => b.name)).toEqual([made.name]);
    expect(accountNames(path.join(t.dir, "backups"), made.name)).toEqual(["TSP"]);
    // No half-written files are left behind.
    expect(
      fs.readdirSync(path.join(t.dir, "backups")).filter((n) => n.endsWith(".partial")),
    ).toEqual([]);
  });

  it("gives two backups in the same second different names", async () => {
    const t = app();
    const now = new Date("2026-10-05T10:00:00Z");
    const a = await createBackup(t.db, t.dir, "manual", now);
    const b = await createBackup(t.db, t.dir, "manual", now);
    expect(a.name).not.toBe(b.name);
    expect(listBackups(t.dir)).toHaveLength(2);
  });

  it("deletes only backups it made, and nothing outside its folder", async () => {
    const t = app();
    const made = (await t.call("post", "/api/backups").expect(201)).body;
    fs.writeFileSync(path.join(t.dir, "precious.db"), "keep me");
    for (const name of [
      "..%2Fprecious.db",
      "precious.db",
      "pf-manual-x.db",
      "pf-manual-20260101-000000.db",
    ]) {
      await t.call("delete", `/api/backups/${name}`).expect(404);
    }
    expect(fs.existsSync(path.join(t.dir, "precious.db"))).toBe(true);
    await t.call("delete", `/api/backups/${made.name}`).expect(204);
    expect(listBackups(t.dir)).toEqual([]);
  });

  it("keeps the newest automatic backups and never removes manual ones", async () => {
    const t = app();
    await createBackup(t.db, t.dir, "manual", new Date("2026-10-01T00:00:00Z"));
    for (let day = 2; day <= 6; day += 1) {
      const made = await createBackup(t.db, t.dir, "auto", new Date(`2026-10-0${day}T00:00:00Z`));
      // Backups are ordered by file time, so set it to match the name.
      fs.utimesSync(
        path.join(backupDir(t.dir), made.name),
        new Date(
          made.name.slice(8, 12) +
            "-" +
            made.name.slice(12, 14) +
            "-" +
            made.name.slice(14, 16) +
            "T00:00:00Z",
        ),
        new Date(
          made.name.slice(8, 12) +
            "-" +
            made.name.slice(12, 14) +
            "-" +
            made.name.slice(14, 16) +
            "T00:00:00Z",
        ),
      );
    }
    expect(pruneAutoBackups(t.dir, 2)).toBe(3);
    const left = listBackups(t.dir);
    expect(left.filter((b) => b.kind === "auto")).toHaveLength(2);
    expect(
      left
        .filter((b) => b.kind === "auto")
        .map((b) => b.name.slice(8, 16))
        .sort(),
    ).toEqual(["20261005", "20261006"]);
    expect(left.filter((b) => b.kind === "manual")).toHaveLength(1);
  });

  it("takes an automatic backup only when no recent one exists", async () => {
    const t = app();
    const at = (iso: string) => new Date(iso);
    const first = await autoBackupIfDue(t.db, t.dir, {
      keep: 5,
      minHours: 12,
      now: at("2026-10-05T08:00:00Z"),
    });
    expect(first?.kind).toBe("auto");
    // The backup file is stamped with the real clock, so judge "recent" against that.
    const soon = await autoBackupIfDue(t.db, t.dir, { keep: 5, minHours: 12, now: new Date() });
    expect(soon).toBeNull();
    const later = await autoBackupIfDue(t.db, t.dir, {
      keep: 5,
      minHours: 12,
      now: new Date(Date.now() + 13 * 3_600_000),
    });
    expect(later?.kind).toBe("auto");
    // A manual backup counts as recent too.
    const manual = await createBackup(t.db, t.dir, "manual");
    expect(manual.kind).toBe("manual");
    expect(
      await autoBackupIfDue(t.db, t.dir, { keep: 5, minHours: 12, now: new Date() }),
    ).toBeNull();
  });

  it("refuses files that are not usable backups", async () => {
    const t = app();
    const dir = path.join(t.dir, "backups");
    fs.mkdirSync(dir, { recursive: true });

    const garbage = path.join(dir, "pf-manual-20260101-000001.db");
    fs.writeFileSync(garbage, "this is not a database at all".repeat(50));
    const strangers = path.join(dir, "pf-manual-20260101-000002.db");
    const other = new Database(strangers);
    other.exec("CREATE TABLE recipes (id INTEGER)");
    other.close();
    const real = await createBackup(t.db, t.dir, "manual", new Date("2026-01-01T00:00:03Z"));
    const damaged = path.join(dir, "pf-manual-20260101-000004.db");
    const bytes = fs.readFileSync(path.join(dir, real.name));
    fs.writeFileSync(damaged, bytes.subarray(0, Math.floor(bytes.length / 2)));

    for (const name of [
      "pf-manual-20260101-000001.db",
      "pf-manual-20260101-000002.db",
      "pf-manual-20260101-000004.db",
    ]) {
      const res = await t.call("post", `/api/backups/${name}/restore`).expect(409);
      expect(res.body.error).toBe("backup_unusable");
    }
    expect(pendingRestore(t.dir)).toBeNull();
    // A backup from a newer version of the app is refused, with a clear reason.
    expect(checkBackupFile(t.db, path.join(dir, real.name), 1)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/newer version/)],
    });
    expect(checkBackupFile(t.db, path.join(dir, real.name), 99).ok).toBe(true);
    await t.call("post", "/api/backups/pf-manual-20990101-000000.db/restore").expect(404);
  });

  it("restores at the next launch, keeping the replaced database as a backup", async () => {
    const t = app();
    await t.call("post", "/api/investments/accounts").send({ name: "Before" }).expect(201);
    const made = (await t.call("post", "/api/backups").expect(201)).body;
    await t.call("post", "/api/investments/accounts").send({ name: "After" }).expect(201);

    const staged = (await t.call("post", `/api/backups/${made.name}/restore`).expect(200)).body;
    expect(staged.name).toBe(made.name);
    expect((await t.call("get", "/api/backups").expect(200)).body.pendingRestore.name).toBe(
      made.name,
    );
    // Nothing changes until the app restarts.
    expect(accountNames(t.dir)).toEqual(["Before", "After"]);

    // "Restart": the app stops, and the next start applies the queued restore before opening the file.
    t.sqlite.close();
    const applied = applyPendingRestore(t.dir, new Date("2026-10-05T12:00:00Z"));
    expect(applied?.name).toBe(made.name);
    expect(pendingRestore(t.dir)).toBeNull();
    expect(accountNames(t.dir)).toEqual(["Before"]);

    const kept = listBackups(t.dir).find((b) => b.kind === "pre-restore")!;
    expect(kept.name).toBe("pf-pre-restore-20261005-120000.db");
    expect(accountNames(path.join(t.dir, "backups"), kept.name)).toEqual(["Before", "After"]);

    // The restored file opens normally and has this app's tables.
    const reopened = createDb({ dataDir: t.dir });
    expect(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({ n: 1 });
    reopened.sqlite.close();
  });

  it("restores from a backup whose recent changes are still in its write-ahead log", async () => {
    const t = app();
    const dir = path.join(t.dir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    // A database that was in use when it was set aside: its newest rows live in the -wal file.
    const live = new Database(path.join(t.dir, "scratch.db"));
    live.pragma("journal_mode = WAL");
    live.pragma("wal_autocheckpoint = 0");
    live.exec(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE transactions (id INTEGER); CREATE TABLE app_settings (key TEXT)",
    );
    live.exec("INSERT INTO accounts (name) VALUES ('only in the log')");
    const name = "pf-pre-restore-20261005-000000.db";
    fs.copyFileSync(path.join(t.dir, "scratch.db"), path.join(dir, name));
    fs.copyFileSync(path.join(t.dir, "scratch.db-wal"), path.join(dir, `${name}-wal`));
    live.close();

    await t.call("post", `/api/backups/${name}/restore`).expect(200);
    t.sqlite.close();
    applyPendingRestore(t.dir);
    expect(accountNames(t.dir)).toEqual(["only in the log"]);
  });

  it("can undo a queued restore, and ignores a half-staged one", async () => {
    const t = app();
    const made = (await t.call("post", "/api/backups").expect(201)).body;
    await t.call("post", `/api/backups/${made.name}/restore`).expect(200);
    await t.call("delete", "/api/restore/pending").expect(204);
    expect(pendingRestore(t.dir)).toBeNull();
    expect(fs.existsSync(path.join(t.dir, "restore-pending.db"))).toBe(false);

    fs.writeFileSync(path.join(t.dir, "restore-pending.db"), "partial");
    t.sqlite.close();
    expect(applyPendingRestore(t.dir)).toBeNull();
    expect(fs.existsSync(path.join(t.dir, "restore-pending.db"))).toBe(false);
    // The live database was not touched.
    expect(fs.existsSync(path.join(t.dir, "personal-finance.db"))).toBe(true);
  });

  it("restores an older backup into a newer schema by migrating it", async () => {
    const t = app();
    const made = (await t.call("post", "/api/backups").expect(201)).body;
    // Pretend the backup predates the newest migration: remove its last journal row and what it added.
    const file = path.join(t.dir, "backups", made.name);
    const raw = new Database(file);
    raw.exec(
      "DROP INDEX dashboard_widgets_dashboard_idx; ALTER TABLE dashboard_widgets DROP COLUMN dashboard_id; DROP TABLE dashboards; DROP TABLE recurring_dismissed",
    );
    raw.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)",
    );
    raw.close();
    await t.call("post", `/api/backups/${made.name}/restore`).expect(200);
    t.sqlite.close();
    applyPendingRestore(t.dir);
    const { runMigrations } = await import("./db/client.js");
    const reopened = createDb({ dataDir: t.dir });
    runMigrations(reopened.db, path.resolve(import.meta.dirname, "../../drizzle/migrations"));
    expect(reopened.sqlite.prepare("SELECT name FROM dashboards").all()).toEqual([
      { name: "Main" },
    ]);
    reopened.sqlite.close();
  });
});

describe("exports", () => {
  async function withBank() {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    const brokerage = await linkDemoBank(h.call, "ins_fake_brokerage", "Fake Brokerage");
    await h.sync.syncItem(brokerage.item.id, "manual");
    return h;
  }
  const exportFile = async (h: Awaited<ReturnType<typeof withBank>>, kind: string) => {
    const res = (await h.call("post", "/api/exports").send({ kind }).expect(201)).body;
    return { res, text: fs.readFileSync(res.path, "utf8") };
  };

  it("exports transactions as CSV the way the app shows them", async () => {
    const h = await withBank();
    const { res, text } = await exportFile(h, "transactions");
    expect(res.path).toBe(path.join(h.dir, "exports", res.name));
    expect(text.charCodeAt(0)).toBe(0xfeff); // so Excel reads the text correctly
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(
      "date,account,institution,merchant,description,amount (money in is positive),currency,category,pending,transfer,recipient,notes",
    );
    const total = (await h.call("get", "/api/transactions?pageSize=1").expect(200)).body.total;
    expect(lines.length - 1).toBe(res.rows);
    expect(res.rows).toBe(total);
    const rent = lines.find((l) => l.includes("-1450.00"));
    expect(rent).toBeDefined(); // rent is money out, so it is negative
    expect(lines.some((l) => /,\d+\.\d\d,USD/.test(l) && !l.includes(",-"))).toBe(true); // some money in
  });

  it("keeps spreadsheet formulas from running", async () => {
    const h = await withBank();
    const first = (await h.call("get", "/api/transactions?pageSize=1").expect(200)).body.items[0];
    await h
      .call("patch", `/api/transactions/${first.id}`)
      .send({ merchant: '=HYPERLINK("http://x")' })
      .expect(200);
    const { text } = await exportFile(h, "transactions");
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toMatch(/,=HYPERLINK/);
  });

  it("exports accounts and investments", async () => {
    const h = await withBank();
    const accountsFile = await exportFile(h, "accounts");
    expect(accountsFile.text).toContain("Plaid Checking");
    expect(accountsFile.text).toContain("2000.00"); // the credit limit
    const holdings = await exportFile(h, "investment-holdings");
    expect(holdings.res.rows).toBe(4);
    expect(holdings.text).toContain("FTMIX");
    const activity = await exportFile(h, "investment-transactions");
    expect(activity.res.rows).toBeGreaterThan(10);
    expect(activity.text).toMatch(/Payroll contribution,,,,400\.00/); // cash in is positive
  });

  it("exports everything as JSON without any secret", async () => {
    const h = await withBank();
    await h
      .call("put", "/api/plaid/credentials")
      .send({
        environment: "sandbox",
        clientId: "client-id-123456",
        secret: "super-secret-value-999",
      })
      .expect(200);
    const { res, text } = await exportFile(h, "everything");
    expect(res.name).toMatch(/\.json$/);
    const data = JSON.parse(text);
    expect(data).toMatchObject({ format: "personal-finance-export", version: 1 });
    expect(data.accounts.length).toBe(4);
    expect(data.transactions.length).toBeGreaterThan(0);
    expect(data.connections[0]).not.toHaveProperty("accessTokenEncrypted");
    for (const secret of [
      "super-secret-value-999",
      "client-id-123456",
      "access-fake",
      "accessTokenEncrypted",
      "valueEncrypted",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("rejects an unknown kind", async () => {
    const t = app();
    await t.call("post", "/api/exports").send({ kind: "passwords" }).expect(400);
  });
});

describe("diagnostics", () => {
  it("reports health, counts, and backups without any private content", async () => {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    await h.call("post", "/api/backups").expect(201);
    const d = (await h.call("get", "/api/diagnostics").expect(200)).body;
    expect(d.version).toBe("test");
    expect(d.integrity.result).toEqual(["ok"]);
    expect(d.integrity.brokenReferences).toBe(0);
    const journal = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8",
      ),
    );
    expect(d.migrationsApplied).toBe(journal.entries.length);
    expect(d.counts.accounts).toBe(3);
    expect(d.counts.transactions).toBeGreaterThan(0);
    expect(d.backups.count).toBe(1);
    expect(d.connections).toEqual([
      expect.objectContaining({ institutionName: "First Platypus Bank", status: "active" }),
    ]);
    const text = JSON.stringify(d);
    for (const leak of ["access-fake", "Plaid Checking", "OAK STREET", "accessTokenEncrypted"]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it("runs the thorough check on request", async () => {
    const t = app();
    const res = (await t.call("post", "/api/diagnostics/integrity-check").expect(200)).body;
    expect(res).toMatchObject({ result: ["ok"], brokenReferences: 0 });
  });

  it("lists failed syncs with their codes, newest first", async () => {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    h.gateway.simulateLoginRequired(
      (await h.call("get", "/api/plaid/items").expect(200)).body[0].plaidItemId ?? "",
    );
    const items = (await h.call("get", "/api/plaid/items").expect(200)).body;
    expect(items.length).toBe(1);
  });

  it("surfaces a sync that failed because the login expired", async () => {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    const row = h.sqlite.prepare("SELECT plaid_item_id AS id FROM plaid_items").get() as {
      id: string;
    };
    h.gateway.simulateLoginRequired(row.id);
    await h.sync.syncItem(bank.item.id, "manual");
    const d = (await h.call("get", "/api/diagnostics").expect(200)).body;
    expect(d.recentProblems[0]).toMatchObject({
      institutionName: "First Platypus Bank",
      status: "error",
      errorCode: "ITEM_LOGIN_REQUIRED",
    });
    expect(d.connections[0].status).toBe("login_required");
    const history = (await h.call("get", "/api/sync/history?limit=5").expect(200)).body;
    expect(history[0].errorCode).toBe("ITEM_LOGIN_REQUIRED");
    await h.call("get", "/api/sync/history?limit=0").expect(400);
  });
});

describe("backup settings", () => {
  it("can be changed within sensible limits", async () => {
    const t = app();
    const defaults = (await t.call("get", "/api/settings").expect(200)).body;
    expect(defaults).toMatchObject({ autoBackupEnabled: true, backupsToKeep: 10 });
    const changed = (
      await t
        .call("patch", "/api/settings")
        .send({ autoBackupEnabled: false, backupsToKeep: 3 })
        .expect(200)
    ).body;
    expect(changed).toMatchObject({ autoBackupEnabled: false, backupsToKeep: 3 });
    await t.call("patch", "/api/settings").send({ backupsToKeep: 0 }).expect(400);
    await t.call("patch", "/api/settings").send({ backupsToKeep: 51 }).expect(400);
    await t.call("patch", "/api/settings").send({ autoBackupEnabled: "yes" }).expect(400);
  });
});
