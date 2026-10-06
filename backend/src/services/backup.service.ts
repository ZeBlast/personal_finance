import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AppDb } from "../db/client.js";
import { DB_FILE_NAME } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";

/**
 * Backups are complete copies of the database file, made while the app is running with SQLite's
 * online-backup API (safe even in the middle of a sync). They live in `<data folder>/backups`.
 *
 * Restoring is staged: the chosen backup is checked and copied beside the database as
 * `restore-pending.db`, and the swap happens at the next launch BEFORE the database is opened (a
 * live database cannot be replaced safely from under the running app). The database that was in
 * use is kept as a `pre-restore` backup first, so a restore can itself be undone.
 */

export type BackupKind = "manual" | "auto" | "pre-restore";

export interface BackupInfo {
  name: string;
  kind: BackupKind;
  sizeBytes: number;
  /** When the file was written (ISO). */
  createdAt: string;
}

export interface PendingRestore {
  name: string;
  stagedAt: string;
}

const NAME_PATTERN = /^pf-(manual|auto|pre-restore)-\d{8}-\d{6}(?:-\d+)?\.db$/;
const PENDING_DB = "restore-pending.db";
const PENDING_META = "restore-pending.json";

export const backupDir = (dataDir: string): string => path.join(dataDir, "backups");

const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");

function describe(dir: string, name: string): BackupInfo {
  const stat = fs.statSync(path.join(dir, name));
  return {
    name,
    kind: NAME_PATTERN.exec(name)![1] as BackupKind,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString(),
  };
}

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => NAME_PATTERN.test(name))
    .map((name) => describe(dir, name))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/** Only names this module made are accepted, so a request can never reach another file. */
function requireBackupName(name: string): string {
  if (!NAME_PATTERN.test(name)) throw notFound("That backup");
  return name;
}

function client(db: AppDb): Database.Database {
  return (db as unknown as { $client: Database.Database }).$client;
}

/** Writes a backup now and returns it. The file appears only once it is complete. */
export async function createBackup(
  db: AppDb,
  dataDir: string,
  kind: BackupKind,
  now: Date = new Date(),
): Promise<BackupInfo> {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  let name = `pf-${kind}-${stamp(now)}.db`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n += 1) {
    name = `pf-${kind}-${stamp(now)}-${n}.db`;
  }
  const partial = path.join(dir, `${name}.partial`);
  try {
    await client(db).backup(partial);
    fs.renameSync(partial, path.join(dir, name));
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw new AppError(
      500,
      "backup_failed",
      `The backup could not be written (${error instanceof Error ? error.message : "unknown error"}). Check that the disk has room.`,
    );
  }
  return describe(dir, name);
}

/** Files that belong with a backup (a pre-restore backup may carry its write-ahead log). */
const companions = (file: string): string[] => [`${file}-wal`, `${file}-shm`];

export function deleteBackup(dataDir: string, name: string): void {
  const file = path.join(backupDir(dataDir), requireBackupName(name));
  if (!fs.existsSync(file)) throw notFound("That backup");
  fs.rmSync(file, { force: true });
  for (const extra of companions(file)) fs.rmSync(extra, { force: true });
}

/** Keeps the newest `keep` automatic backups and removes older ones. Manual ones are never touched. */
export function pruneAutoBackups(dataDir: string, keep: number): number {
  const old = listBackups(dataDir)
    .filter((b) => b.kind === "auto")
    .slice(Math.max(0, keep));
  for (const b of old) deleteBackup(dataDir, b.name);
  return old.length;
}

/**
 * Takes an automatic backup unless a recent backup of any kind already exists, so launching the
 * app several times in a day does not pile up copies. Returns the new backup, or null.
 */
export async function autoBackupIfDue(
  db: AppDb,
  dataDir: string,
  options: { keep: number; minHours: number; now?: Date },
): Promise<BackupInfo | null> {
  const now = options.now ?? new Date();
  const newest = listBackups(dataDir).find((b) => b.kind !== "pre-restore");
  if (newest && now.getTime() - Date.parse(newest.createdAt) < options.minHours * 3_600_000) {
    return null;
  }
  const made = await createBackup(db, dataDir, "auto", now);
  pruneAutoBackups(dataDir, options.keep);
  return made;
}

export interface BackupCheck {
  ok: boolean;
  /** What is wrong, in words a person can act on. Empty when ok. */
  problems: string[];
  migrations: number;
}

/**
 * Looks inside a database file without using it: it must be a healthy SQLite file that holds this
 * app's data, and must not come from a NEWER version of the app (this version could not read it).
 * The file is attached to the live connection for the duration of the check and only read.
 */
export function checkBackupFile(db: AppDb, file: string, knownMigrations: number): BackupCheck {
  const sqlite = client(db);
  const problems: string[] = [];
  let migrations = 0;
  try {
    sqlite.prepare("ATTACH DATABASE ? AS candidate").run(file);
  } catch {
    return { ok: false, problems: ["That file is not a readable database."], migrations: 0 };
  }
  try {
    const integrity = sqlite.prepare("PRAGMA candidate.integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") {
      problems.push("The file is damaged (it failed SQLite's integrity check).");
    } else {
      const tables = new Set(
        (
          sqlite
            .prepare("SELECT name FROM candidate.sqlite_master WHERE type = 'table'")
            .all() as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      );
      for (const required of ["accounts", "transactions", "app_settings"]) {
        if (!tables.has(required))
          problems.push(`It does not look like this app's data (no "${required}" table).`);
      }
      if (tables.has("__drizzle_migrations")) {
        migrations = (
          sqlite.prepare("SELECT COUNT(*) AS n FROM candidate.__drizzle_migrations").get() as {
            n: number;
          }
        ).n;
        if (migrations > knownMigrations) {
          problems.push(
            "It was made by a newer version of this app. Update the app, then restore it.",
          );
        }
      }
    }
  } catch {
    problems.push("The file could not be read as this app's data.");
  } finally {
    try {
      sqlite.prepare("DETACH DATABASE candidate").run();
    } catch {
      // Nothing more to do: the connection is dropped when the app exits.
    }
  }
  return { ok: problems.length === 0, problems, migrations };
}

/**
 * Copies a backup into one self-contained file. A backup that was set aside while the app was
 * running (a `pre-restore` one) can have recent changes in a separate write-ahead log; reading it
 * through SQLite and writing it out with VACUUM INTO includes them, which copying the file would not.
 */
function copyConsolidated(db: AppDb, source: string, target: string): void {
  const sqlite = client(db);
  fs.rmSync(target, { force: true });
  sqlite.prepare("ATTACH DATABASE ? AS candidate").run(source);
  try {
    sqlite.prepare("VACUUM candidate INTO ?").run(target);
  } finally {
    sqlite.prepare("DETACH DATABASE candidate").run();
  }
}

export function pendingRestore(dataDir: string): PendingRestore | null {
  const meta = path.join(dataDir, PENDING_META);
  if (!fs.existsSync(path.join(dataDir, PENDING_DB)) || !fs.existsSync(meta)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(meta, "utf8")) as Partial<PendingRestore>;
    return typeof parsed.name === "string" && typeof parsed.stagedAt === "string"
      ? { name: parsed.name, stagedAt: parsed.stagedAt }
      : null;
  } catch {
    return null;
  }
}

/** Checks a backup and queues it to replace the database at the next launch. */
export function stageRestore(
  db: AppDb,
  dataDir: string,
  name: string,
  knownMigrations: number,
  now: Date = new Date(),
): PendingRestore {
  const source = path.join(backupDir(dataDir), requireBackupName(name));
  if (!fs.existsSync(source)) throw notFound("That backup");
  const check = checkBackupFile(db, source, knownMigrations);
  if (!check.ok) {
    throw new AppError(
      409,
      "backup_unusable",
      `This backup cannot be restored. ${check.problems.join(" ")}`,
    );
  }
  const target = path.join(dataDir, PENDING_DB);
  copyConsolidated(db, source, `${target}.partial`);
  fs.renameSync(`${target}.partial`, target);
  const pending: PendingRestore = { name, stagedAt: now.toISOString() };
  fs.writeFileSync(path.join(dataDir, PENDING_META), JSON.stringify(pending));
  return pending;
}

export function cancelRestore(dataDir: string): void {
  fs.rmSync(path.join(dataDir, PENDING_DB), { force: true });
  fs.rmSync(path.join(dataDir, PENDING_META), { force: true });
}

/**
 * Called at startup, before the database is opened. If a restore is queued, the current database
 * is kept as a `pre-restore` backup and the chosen backup takes its place. Returns what happened.
 */
export function applyPendingRestore(
  dataDir: string,
  now: Date = new Date(),
): PendingRestore | null {
  const pending = pendingRestore(dataDir);
  if (!pending) {
    // A half-staged restore (file without its note) is discarded rather than guessed at.
    cancelRestore(dataDir);
    return null;
  }
  const live = path.join(dataDir, DB_FILE_NAME);
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(live)) {
    let name = `pf-pre-restore-${stamp(now)}.db`;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n += 1) {
      name = `pf-pre-restore-${stamp(now)}-${n}.db`;
    }
    // Moved together with its write-ahead log, so nothing the app had saved is left behind.
    const kept = path.join(dir, name);
    fs.renameSync(live, kept);
    for (const extra of companions(live)) {
      if (fs.existsSync(extra)) fs.renameSync(extra, `${kept}${extra.slice(live.length)}`);
    }
  }
  fs.renameSync(path.join(dataDir, PENDING_DB), live);
  fs.rmSync(path.join(dataDir, PENDING_META), { force: true });
  return pending;
}
