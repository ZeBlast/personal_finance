import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import { plaidItems, syncRuns } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { DB_FILE_NAME } from "../db/client.js";
import {
  listBackups,
  pendingRestore,
  type BackupInfo,
  type PendingRestore,
} from "./backup.service.js";
import { getSettings } from "./settings.service.js";

/**
 * A health report about the app's own data. It contains counts, sizes, dates and short error
 * codes only: never transaction contents, account numbers, tokens, or credentials, so it is safe
 * to copy into a message when asking for help.
 */

const client = (db: AppDb): Database.Database =>
  (db as unknown as { $client: Database.Database }).$client;

const COUNTED_TABLES = [
  "accounts",
  "transactions",
  "categories",
  "transaction_rules",
  "budgets",
  "credit_limit_history",
  "balance_snapshots",
  "securities",
  "holdings",
  "holding_snapshots",
  "investment_transactions",
  "sync_runs",
] as const;

export interface SyncProblem {
  id: number;
  institutionName: string;
  trigger: string;
  status: string;
  startedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface IntegrityReport {
  /** `ok`, or the problems SQLite found (at most a handful of lines). */
  result: string[];
  /** Rows that point at something that no longer exists (should be zero). */
  brokenReferences: number;
  checkedAt: string;
}

export interface Diagnostics {
  version: string;
  dataDir: string;
  databaseFile: string;
  databaseBytes: number;
  migrationsApplied: number;
  environment: string;
  counts: Record<string, number>;
  integrity: IntegrityReport;
  backups: { count: number; newest: BackupInfo | null; pendingRestore: PendingRestore | null };
  connections: Array<{
    id: number;
    institutionName: string;
    status: string;
    lastSuccessfulSyncAt: string | null;
    lastErrorCode: string | null;
  }>;
  recentProblems: SyncProblem[];
}

/** SQLite's own checks. `full` also verifies every index against its table, which takes longer. */
export function checkIntegrity(db: AppDb, full: boolean): IntegrityReport {
  const sqlite = client(db);
  const rows = sqlite
    .prepare(full ? "PRAGMA integrity_check" : "PRAGMA quick_check")
    .all() as Array<Record<string, string>>;
  const result = rows.map((r) => Object.values(r)[0] ?? "").slice(0, 10);
  const broken = sqlite.prepare("PRAGMA foreign_key_check").all().length;
  return { result, brokenReferences: broken, checkedAt: new Date().toISOString() };
}

export function recentSyncProblems(db: AppDb, limit: number): SyncProblem[] {
  return db
    .select({
      id: syncRuns.id,
      institutionName: plaidItems.institutionName,
      trigger: syncRuns.trigger,
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
      errorCode: syncRuns.errorCode,
      errorMessage: syncRuns.errorMessage,
    })
    .from(syncRuns)
    .innerJoin(plaidItems, eq(syncRuns.plaidItemId, plaidItems.id))
    .orderBy(desc(syncRuns.id))
    .limit(limit)
    .all();
}

export function diagnostics(db: AppDb, options: { dataDir: string; version: string }): Diagnostics {
  const sqlite = client(db);
  const file = path.join(options.dataDir, DB_FILE_NAME);
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
    ).n;
  }
  let migrations = 0;
  try {
    migrations = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }
    ).n;
  } catch {
    // No journal table yet: nothing has been applied.
  }
  const backups = listBackups(options.dataDir);
  return {
    version: options.version,
    dataDir: options.dataDir,
    databaseFile: file,
    databaseBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    migrationsApplied: migrations,
    environment: getSettings(db).plaidEnvironment,
    counts,
    integrity: checkIntegrity(db, false),
    backups: {
      count: backups.length,
      newest: backups[0] ?? null,
      pendingRestore: pendingRestore(options.dataDir),
    },
    connections: db
      .select({
        id: plaidItems.id,
        institutionName: plaidItems.institutionName,
        status: plaidItems.status,
        lastSuccessfulSyncAt: plaidItems.lastSuccessfulSyncAt,
        lastErrorCode: plaidItems.lastErrorCode,
      })
      .from(plaidItems)
      .all(),
    recentProblems: recentSyncProblems(db, 40)
      .filter((r) => r.status !== "success")
      .slice(0, 15),
  };
}
