import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { credentials, plaidItems } from "../../../drizzle/schema.js";
import { DatabaseKeyError, openForeignDatabase, type AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import type { CredentialEnvironment } from "./credentials.service.js";
import { createCipher, deriveDatabaseKey, isValidKeyHex, type TokenCipher } from "./crypto.js";

/**
 * Borrowing connections from another install of the app (the real one) for development.
 *
 * Linking a bank gives the app an access token. The same token works from a second copy of the app
 * (each keeps its own sync position), so a development copy can read the real accounts without
 * linking again. This reads the token, and the Plaid keys it needs, out of a BACKUP of the real
 * app's database, opened with that install's recovery key, and saves them in this database under
 * this install's own key.
 *
 * What it must never do is change the real connection. Borrowed connections are marked, and
 * everything that would alter a connection at Plaid (disconnect, sign in again, repair) is
 * refused for them (see plaid.service); they sync only when asked. The real app's database is never
 * written: the backup is opened read-only.
 */

export interface BorrowableConnection {
  institutionName: string;
  environment: string;
  status: string;
  /** Why it will not be borrowed, or null when it can be. */
  skip: "demo" | "already_here" | "borrowed_in_source" | "not_in_environment" | null;
}

export interface BorrowResult {
  borrowed: Array<{ institutionName: string; environment: string }>;
  skipped: BorrowableConnection[];
  /** Plaid keys copied in, and environments where this install already had its own and kept them. */
  credentials: { copied: CredentialEnvironment[]; kept: CredentialEnvironment[] };
}

interface SourceItem {
  plaid_item_id: string;
  environment: string;
  institution_id: string | null;
  institution_name: string;
  access_token_encrypted: string;
  days_requested: number;
  status: string;
  borrowed?: number;
}

/**
 * Opens the backup, trying the real install's database key, then none (an older, unencrypted one).
 * It works on a private COPY in the temporary folder, so nothing is ever created or changed beside
 * the real app's files (opening a database can leave small helper files next to it).
 */
function openSource(file: string, masterKeyHex: string, nativeDir?: string) {
  if (!isValidKeyHex(masterKeyHex)) {
    throw new AppError(400, "invalid_recovery_key", "A recovery key is 64 letters and digits.");
  }
  if (!fs.existsSync(file))
    throw new AppError(400, "backup_not_found", "That backup file does not exist.");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pf-borrow-"));
  const copy = path.join(scratch, "source.db");
  fs.copyFileSync(file, copy);
  // A backup set aside while the app ran can have recent changes in a write-ahead log beside it.
  for (const extra of ["-wal", "-shm"]) {
    if (fs.existsSync(file + extra)) fs.copyFileSync(file + extra, copy + extra);
  }
  const dispose = (): void => fs.rmSync(scratch, { recursive: true, force: true });
  try {
    for (const key of [deriveDatabaseKey(masterKeyHex), null]) {
      try {
        const db = openForeignDatabase(copy, key, nativeDir);
        return {
          db,
          dispose() {
            db.close();
            dispose();
          },
        };
      } catch (error) {
        if (!(error instanceof DatabaseKeyError)) throw error;
      }
    }
  } catch (error) {
    dispose();
    throw error;
  }
  dispose();
  throw new AppError(
    400,
    "backup_not_readable",
    "That recovery key does not open this backup (or the file is damaged).",
  );
}

function classify(
  db: AppDb,
  item: SourceItem,
  environments: string[] | undefined,
): BorrowableConnection["skip"] {
  if (item.environment === "fake") return "demo";
  if (environments && !environments.includes(item.environment)) return "not_in_environment";
  if (item.borrowed) return "borrowed_in_source";
  const existing = db
    .select({ id: plaidItems.id })
    .from(plaidItems)
    .where(eq(plaidItems.plaidItemId, item.plaid_item_id))
    .get();
  return existing ? "already_here" : null;
}

function readItems(source: ReturnType<typeof openSource>["db"]): SourceItem[] {
  try {
    return source.prepare("SELECT * FROM plaid_items ORDER BY id").all() as SourceItem[];
  } catch {
    throw new AppError(
      400,
      "not_app_data",
      "That file does not look like this app's data (it has no connections table).",
    );
  }
}

/** What would be borrowed, without reading any secret. For showing the user before they agree. */
export function previewBorrow(
  db: AppDb,
  options: {
    sourceFile: string;
    sourceMasterKey: string;
    environments?: string[];
    nativeDir?: string;
  },
): BorrowableConnection[] {
  const opened = openSource(options.sourceFile, options.sourceMasterKey, options.nativeDir);
  try {
    return readItems(opened.db).map((item) => ({
      institutionName: item.institution_name,
      environment: item.environment,
      status: item.status,
      skip: classify(db, item, options.environments),
    }));
  } finally {
    opened.dispose();
  }
}

/** Copies the real app's connections (and the Plaid keys they need) in, marked as borrowed. */
export function borrowConnections(
  db: AppDb,
  cipher: TokenCipher,
  options: {
    sourceFile: string;
    sourceMasterKey: string;
    /** Only these environments (default: every real one in the backup). */
    environments?: string[];
    /** Replace this install's own Plaid keys for an environment instead of keeping them. */
    replaceCredentials?: boolean;
    nativeDir?: string;
    /** Where this install's own database file is, to refuse borrowing from itself. */
    ownFile?: string;
  },
): BorrowResult {
  if (options.ownFile && path.resolve(options.ownFile) === path.resolve(options.sourceFile)) {
    throw new AppError(
      400,
      "same_database",
      "That is this install's own database, not the real app's.",
    );
  }
  const opened = openSource(options.sourceFile, options.sourceMasterKey, options.nativeDir);
  const source = opened.db;
  const sourceCipher = createCipher(options.sourceMasterKey);
  const result: BorrowResult = { borrowed: [], skipped: [], credentials: { copied: [], kept: [] } };
  const now = new Date().toISOString();

  try {
    const items = readItems(source);
    const wanted = new Set<string>();

    db.transaction((tx) => {
      for (const item of items) {
        const skip = classify(db, item, options.environments);
        if (skip !== null) {
          result.skipped.push({
            institutionName: item.institution_name,
            environment: item.environment,
            status: item.status,
            skip,
          });
          continue;
        }
        let token: string;
        try {
          token = sourceCipher.decrypt(item.access_token_encrypted, item.plaid_item_id);
        } catch {
          throw new AppError(
            400,
            "token_unreadable",
            "A saved connection in that backup could not be read with this recovery key. Nothing was changed.",
          );
        }
        tx.insert(plaidItems)
          .values({
            plaidItemId: item.plaid_item_id,
            environment: item.environment,
            institutionId: item.institution_id,
            institutionName: item.institution_name,
            accessTokenEncrypted: cipher.encrypt(token, item.plaid_item_id),
            status: "active",
            daysRequested: item.days_requested,
            borrowed: true,
            // This install keeps its own sync position, so it reads the full history itself.
            syncCursor: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        wanted.add(item.environment);
        result.borrowed.push({
          institutionName: item.institution_name,
          environment: item.environment,
        });
      }

      // The Plaid keys the borrowed connections belong to (an access token only works with the
      // client ID and secret it was issued under).
      for (const environment of wanted) {
        if (environment !== "sandbox" && environment !== "production") continue;
        const keys = [`plaid.${environment}.client_id`, `plaid.${environment}.secret`];
        const rows = keys.map(
          (key) =>
            source.prepare("SELECT value_encrypted FROM credentials WHERE key = ?").get(key) as
              { value_encrypted: string } | undefined,
        );
        if (rows.some((r) => r === undefined)) continue;
        const own = tx.select({ key: credentials.key }).from(credentials).all();
        const hasOwn = keys.every((k) => own.some((o) => o.key === k));
        if (hasOwn && !options.replaceCredentials) {
          result.credentials.kept.push(environment);
          continue;
        }
        for (const [i, key] of keys.entries()) {
          let value: string;
          try {
            value = sourceCipher.decrypt(rows[i]!.value_encrypted, key);
          } catch {
            throw new AppError(
              400,
              "credentials_unreadable",
              "The saved Plaid keys in that backup could not be read. Nothing was changed.",
            );
          }
          const valueEncrypted = cipher.encrypt(value, key);
          tx.insert(credentials)
            .values({ key, valueEncrypted, updatedAt: now })
            .onConflictDoUpdate({
              target: credentials.key,
              set: { valueEncrypted, updatedAt: now },
            })
            .run();
        }
        result.credentials.copied.push(environment);
      }
    });
  } finally {
    opened.dispose();
  }
  return result;
}
