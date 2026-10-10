/**
 * Development only: borrow the real app's bank connections, once, so this copy can read the same
 * accounts without linking again. Run it from a normal terminal (it asks for the recovery key
 * without showing it):
 *
 *   npm run dev:borrow
 *
 * Nothing in the real app changes: the backup is read through a private copy, and the borrowed
 * connections can never disconnect or repair the real ones (see services/borrow.service.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import { createDb, runMigrations } from "../db/client.js";
import { borrowConnections, previewBorrow } from "../services/borrow.service.js";
import {
  createCipher,
  deriveDatabaseKey,
  isValidKeyHex,
  resolveEncryptionKey,
} from "../services/crypto.js";

const REAL_APP_FOLDER = "com.personalfinance.app";

interface Args {
  backup?: string;
  environments: string[];
  replaceCredentials: boolean;
  yes: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { environments: [], replaceCredentials: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--backup") args.backup = argv[++i];
    else if (a === "--environment") args.environments.push(argv[++i]!);
    else if (a === "--replace-credentials") args.replaceCredentials = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (args.environments.length === 0) args.environments = ["production"];
  return args;
}

/** The newest backup the real app has made. */
function newestRealBackup(): string {
  const dir = path.join(process.env["APPDATA"] ?? "", REAL_APP_FOLDER, "backups");
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => /^pf-.*\.db$/.test(n))
        .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : [];
  if (files.length === 0) {
    throw new Error(
      `No backups found in ${dir}. In the real app, open Data and backups and choose Back up now, then run this again.`,
    );
  }
  return path.join(dir, files[0]!.n);
}

/** Reads a line without showing it. Needs a real terminal. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(
        new Error(
          "This needs a real terminal to ask for the recovery key without showing it. Open a normal PowerShell window and run it there.",
        ),
      );
      return;
    }
    process.stdout.write(question);
    let text = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          resolve(text);
          return;
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else text += ch;
      }
    };
    input.on("data", onData);
  });
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).trim());
    });
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  if (!env.PF_ALLOW_DEV_ORIGIN) {
    throw new Error(
      "This is for the development copy only (PF_ALLOW_DEV_ORIGIN=1 in .env). Nothing was done.",
    );
  }
  const realFolder = path.join(process.env["APPDATA"] ?? "", REAL_APP_FOLDER);
  if (path.resolve(env.dataDir).toLowerCase() === path.resolve(realFolder).toLowerCase()) {
    throw new Error("PF_DATA_DIR points at the real app's data folder. Nothing was done.");
  }

  const sourceFile = path.resolve(args.backup ?? newestRealBackup());
  console.log(`Backup to read from: ${sourceFile}`);

  let recoveryKey = (process.env["PF_REAL_RECOVERY_KEY"] ?? "").replace(/\s+/g, "").toLowerCase();
  if (recoveryKey === "") {
    recoveryKey = (await promptHidden("Real app's recovery key (hidden): "))
      .replace(/\s+/g, "")
      .toLowerCase();
  }
  if (!isValidKeyHex(recoveryKey))
    throw new Error("A recovery key is 64 letters and digits (0-9, a-f).");

  const devMaster = resolveEncryptionKey({
    PF_ENCRYPTION_KEY: env.PF_ENCRYPTION_KEY,
    PF_ALLOW_DEV_ORIGIN: env.PF_ALLOW_DEV_ORIGIN,
    dataDir: env.dataDir,
  });
  const { db, sqlite, file } = createDb({
    dataDir: env.dataDir,
    key: deriveDatabaseKey(devMaster),
    nativeDir: env.PF_NATIVE_DIR,
  });
  try {
    runMigrations(db, env.migrationsDir);
    const options = { sourceFile, sourceMasterKey: recoveryKey, environments: args.environments };

    console.log(`\nConnections in that backup (${args.environments.join(", ")}):`);
    const preview = previewBorrow(db, options);
    const reasons: Record<string, string> = {
      demo: "demo data",
      already_here: "already here",
      borrowed_in_source: "borrowed there from somewhere else",
      not_in_environment: "other environment",
    };
    for (const c of preview) {
      console.log(
        `  ${c.skip === null ? "+" : "-"} ${c.institutionName} (${c.environment}, ${c.status})${c.skip ? `  - skipped: ${reasons[c.skip]}` : ""}`,
      );
    }
    const toBorrow = preview.filter((c) => c.skip === null);
    if (toBorrow.length === 0) {
      console.log("\nNothing to borrow.");
      return;
    }
    if (args.dryRun) {
      console.log("\nDry run: nothing was changed.");
      return;
    }
    console.log(
      `\nThis copy (${file}) will be able to READ ${toBorrow.length} of the real app's connection(s).\n` +
        "It can never disconnect or repair them, the real app is not changed, and the Plaid keys\n" +
        "they belong to are copied in too.",
    );
    if (!args.yes) {
      const answer = await promptLine("Continue? (y/N) ");
      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled. Nothing was changed.");
        return;
      }
    }
    const result = borrowConnections(db, createCipher(devMaster), {
      ...options,
      replaceCredentials: args.replaceCredentials,
      nativeDir: env.PF_NATIVE_DIR,
      ownFile: file,
    });
    console.log(`\nBorrowed ${result.borrowed.length} connection(s).`);
    if (result.credentials.copied.length > 0) {
      console.log(`Plaid keys copied for: ${result.credentials.copied.join(", ")}.`);
    }
    if (result.credentials.kept.length > 0) {
      console.log(
        `Kept this copy's own Plaid keys for: ${result.credentials.kept.join(", ")} (use --replace-credentials to use the real ones).`,
      );
    }
    console.log(
      "\nNext: in the dev app, open Settings and choose the Production environment, then Accounts and Sync now.\n" +
        "Borrowed connections sync only when you press Sync now.",
    );
  } finally {
    sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
