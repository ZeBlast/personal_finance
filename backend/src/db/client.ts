import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../../../drizzle/schema.js";

export const DB_FILE_NAME = "personal-finance.db";

export type AppDb = ReturnType<typeof createDb>["db"];

interface OpenOptions {
  dataDir: string;
  /** The database key: 64 hex characters (see `deriveDatabaseKey`). */
  key: string;
  /** Folder containing better_sqlite3.node. Only set when running as a single executable. */
  nativeDir?: string | undefined;
}

/** Thrown when the database exists but cannot be opened with the key this computer holds. */
export class DatabaseKeyError extends Error {
  constructor() {
    super(
      "The database could not be opened with this computer's encryption key. If you moved to a new " +
        "computer or reinstalled Windows, the key is lost: restore a backup using your recovery key. " +
        "Nothing has been changed.",
    );
    this.name = "DatabaseKeyError";
  }
}

/** The key each open connection uses, so backups can be read and written with the same key. */
const keys = new WeakMap<object, string>();

export function databaseKeyOf(sqlite: object): string | undefined {
  return keys.get(sqlite);
}

/** SQLCipher's raw-key form: the 32 key bytes as hex, used as they are (no password hashing). */
export const rawKey = (keyHex: string): string => `x'${keyHex}'`;

const PLAIN_HEADER = "SQLite format 3\0";

/** Whether a file is an ordinary, unencrypted SQLite database (an encrypted one has no such header). */
export function isPlaintextDatabase(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(PLAIN_HEADER.length);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return read === buffer.length && buffer.toString("latin1") === PLAIN_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Inside a Node single-executable app, require() cannot load native add-ons, so the add-on is
 * loaded explicitly with process.dlopen and handed to the library.
 */
function nativeOptions(nativeDir: string | undefined): Database.Options {
  if (!nativeDir) return {};
  const addon = { exports: {} } as NodeJS.Module;
  process.dlopen(addon, path.join(nativeDir, "better_sqlite3.node"));
  // The library accepts an already-loaded add-on object, which its typings do not describe.
  return { nativeBinding: addon.exports } as unknown as Database.Options;
}

function useKey(sqlite: Database.Database, keyHex: string, command: "key" | "rekey" = "key"): void {
  sqlite.pragma("cipher='sqlcipher'");
  sqlite.pragma(`${command}="${rawKey(keyHex)}"`);
}

/** What a lost row would show up in: each table with its row count. */
function fingerprint(sqlite: Database.Database): string {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return tables
    .map(
      (t) =>
        `${t.name}=${(sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n}`,
    )
    .join(",");
}

/**
 * Encrypts a plaintext database file where it is. A copy is kept until the encrypted file has been
 * opened again and checked against the original, and put back if anything is wrong. Returns false
 * when the file needs no work.
 */
function encryptInPlace(file: string, keyHex: string, options: Database.Options): boolean {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0 || !isPlaintextDatabase(file)) {
    return false;
  }
  const safetyCopy = `${file}.before-encryption`;

  // Fold the write-ahead log into the file and leave WAL mode, which re-keying needs.
  const plain = new Database(file, options);
  let before: string;
  try {
    plain.pragma("wal_checkpoint(TRUNCATE)");
    plain.pragma("journal_mode = DELETE");
    before = fingerprint(plain);
  } finally {
    plain.close();
  }
  fs.copyFileSync(file, safetyCopy);

  try {
    const target = new Database(file, options);
    try {
      useKey(target, keyHex, "rekey");
    } finally {
      target.close();
    }
    const check = new Database(file, options);
    try {
      useKey(check, keyHex);
      const integrity = check.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") {
        throw new Error("integrity check failed");
      }
      if (fingerprint(check) !== before) throw new Error("the data does not match the original");
    } finally {
      check.close();
    }
  } catch (error) {
    // Put the original back exactly as it was.
    fs.copyFileSync(safetyCopy, file);
    fs.rmSync(safetyCopy, { force: true });
    throw new Error(
      `Could not encrypt the database (${error instanceof Error ? error.message : "unknown error"}). Your data was left as it was.`,
      { cause: error },
    );
  }
  fs.rmSync(safetyCopy, { force: true });
  return true;
}

/**
 * Encrypts the backups an earlier version of the app made as ordinary files. Returns how many were
 * converted. A backup that cannot be converted is left alone.
 */
export function encryptExistingBackups(
  backupsDir: string,
  keyHex: string,
  nativeDir?: string,
): number {
  if (!fs.existsSync(backupsDir)) return 0;
  const options = nativeOptions(nativeDir);
  let converted = 0;
  for (const name of fs.readdirSync(backupsDir)) {
    if (!name.endsWith(".db")) continue;
    try {
      if (encryptInPlace(path.join(backupsDir, name), keyHex, options)) converted += 1;
    } catch {
      // Left as it was; it still restores, and is encrypted the next time it is restored.
    }
  }
  return converted;
}

/**
 * Opens a database file that belongs to another install of the app, to read from it: with its
 * encrypted key, or (for one an earlier version left readable) with none. Read-only, so it can
 * never change that install's data. Throws DatabaseKeyError when the key does not open it.
 */
export function openForeignDatabase(
  file: string,
  keyHex: string | null,
  nativeDir?: string,
): Database.Database {
  const connection = new Database(file, { ...nativeOptions(nativeDir), readonly: true });
  try {
    if (keyHex !== null) useKey(connection, keyHex);
    connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
    return connection;
  } catch (error) {
    connection.close();
    if (error instanceof Error && /not a database|encrypted/i.test(error.message)) {
      throw new DatabaseKeyError();
    }
    throw error;
  }
}

/**
 * Opens (creating if needed) the encrypted SQLite database with the pragmas this app relies on.
 * A database left unencrypted by an earlier version is encrypted first.
 */
export function createDb({ dataDir, key, nativeDir }: OpenOptions) {
  // Anything but 64 hex characters would be taken as a passphrase and weaken the encryption.
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("The database key must be 64 hex characters");
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, DB_FILE_NAME);
  const options = nativeOptions(nativeDir);

  encryptInPlace(file, key, options);

  const open = (): Database.Database => {
    const connection = new Database(file, options);
    try {
      useKey(connection, key);
      // The first read is where a wrong key shows itself.
      connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
      return connection;
    } catch (error) {
      connection.close();
      if (error instanceof Error && /not a database|encrypted/i.test(error.message)) {
        throw new DatabaseKeyError();
      }
      throw error;
    }
  };
  const safetyCopy = `${file}.before-encryption`;
  let sqlite: Database.Database;
  try {
    sqlite = open();
  } catch (error) {
    // A conversion that was cut short leaves the original beside the file: go back and redo it.
    if (!(error instanceof DatabaseKeyError) || !isPlaintextDatabase(safetyCopy)) throw error;
    fs.copyFileSync(safetyCopy, file);
    encryptInPlace(file, key, options);
    sqlite = open();
  }
  // A copy left by an interrupted conversion is no longer needed now the encrypted file opens.
  fs.rmSync(`${file}.before-encryption`, { force: true });
  keys.set(sqlite, key);

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
