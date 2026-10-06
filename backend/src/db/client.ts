import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../../../drizzle/schema.js";

export const DB_FILE_NAME = "personal-finance.db";

export type AppDb = ReturnType<typeof createDb>["db"];

interface OpenOptions {
  dataDir: string;
  /** Folder containing better_sqlite3.node. Only set when running as a single executable. */
  nativeDir?: string | undefined;
}

/**
 * Opens (creating if needed) the SQLite database with the pragmas this app relies on.
 *
 * Inside a Node single-executable app, require() cannot load native add-ons, so the
 * better-sqlite3 add-on is loaded explicitly with process.dlopen and handed to the library.
 */
export function createDb({ dataDir, nativeDir }: OpenOptions) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, DB_FILE_NAME);

  let options: Database.Options = {};
  if (nativeDir) {
    const addon = { exports: {} } as NodeJS.Module;
    process.dlopen(addon, path.join(nativeDir, "better_sqlite3.node"));
    // The library accepts an already-loaded add-on object, which its typings do not describe.
    options = { nativeBinding: addon.exports } as unknown as Database.Options;
  }

  const sqlite = new Database(file, options);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, file };
}

export function runMigrations(db: AppDb, migrationsDir: string): void {
  if (!fs.existsSync(path.join(migrationsDir, "meta", "_journal.json"))) {
    throw new Error(`Migrations not found in ${migrationsDir}`);
  }
  migrate(db, { migrationsFolder: migrationsDir });
}
