/**
 * Development only: opens a phone viewer snapshot on this computer, to check what a phone would see.
 *
 *   npm run dev:viewer -- <snapshot file> [--key <key>] [--out <file.json>]
 *
 * Without --key, the phone's key is looked up in this development copy's own database (the copy
 * that paired the phone). Prints the header and each view with its size; --out also writes the
 * decrypted views as JSON (an ordinary, unencrypted file: delete it when done).
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { viewerDevices } from "../../../drizzle/schema.js";
import { loadEnv } from "../config/env.js";
import { createDb, runMigrations } from "../db/client.js";
import { createCipher, deriveDatabaseKey, resolveEncryptionKey } from "../services/crypto.js";
import { decodeKey, decodeSnapshot, readSnapshotHeader } from "../services/viewer.service.js";

interface Args {
  file: string;
  key?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  let file: string | undefined;
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--key") args.key = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else file = a;
  }
  if (!file)
    throw new Error(
      "Usage: npm run dev:viewer -- <snapshot file> [--key <key>] [--out <file.json>]",
    );
  return { ...args, file: path.resolve(file) };
}

/** The phone's key from this development copy's database. */
function keyFromDatabase(deviceId: string): Buffer {
  const env = loadEnv();
  if (!env.PF_ALLOW_DEV_ORIGIN) {
    throw new Error(
      "Without --key this reads the development copy's database (PF_ALLOW_DEV_ORIGIN=1 in .env).",
    );
  }
  const master = resolveEncryptionKey({
    PF_ENCRYPTION_KEY: env.PF_ENCRYPTION_KEY,
    PF_ALLOW_DEV_ORIGIN: env.PF_ALLOW_DEV_ORIGIN,
    dataDir: env.dataDir,
  });
  const { db, sqlite } = createDb({
    dataDir: env.dataDir,
    key: deriveDatabaseKey(master),
    nativeDir: env.PF_NATIVE_DIR,
  });
  try {
    runMigrations(db, env.migrationsDir);
    const row = db.select().from(viewerDevices).where(eq(viewerDevices.deviceId, deviceId)).get();
    if (!row || row.keyEncrypted === "") {
      throw new Error("That phone is not paired with this copy (or was forgotten). Pass --key.");
    }
    const hex = createCipher(master).decrypt(row.keyEncrypted, `viewer-device:${deviceId}`);
    return Buffer.from(hex, "hex");
  } finally {
    sqlite.close();
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const data = fs.readFileSync(args.file);
  const { header } = readSnapshotHeader(data);
  console.log(
    `Phone ${header.deviceId}, written ${header.createdAt} by version ${header.appVersion}`,
  );
  const key = args.key ? decodeKey(args.key) : keyFromDatabase(header.deviceId);
  const { body } = decodeSnapshot(data, key);
  console.log(`For ${body.today}. ${Object.keys(body.resources).length} views:`);
  for (const [p, value] of Object.entries(body.resources)) {
    const size = Buffer.byteLength(JSON.stringify(value));
    console.log(`  ${p}  (${(size / 1024).toFixed(1)} KB)`);
  }
  if (body.failed.length > 0) console.log(`Could not be read: ${body.failed.join(", ")}`);
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(body, null, 2));
    console.log(
      `\nWrote the decrypted views to ${path.resolve(args.out)}. It is NOT encrypted: delete it when done.`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not open the snapshot.");
  process.exit(1);
}
