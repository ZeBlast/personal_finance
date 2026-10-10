import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb, encryptExistingBackups, runMigrations } from "./db/client.js";
import { createGatewayProvider } from "./plaid/provider.js";
import { rebuildAllTspHistories } from "./services/tsp-history.service.js";
import { tspAccountIds, updateAllTspAccounts } from "./services/tsp.service.js";
import {
  ensureDiningSplit,
  ensureStarterAdditions,
  ensureTransferSubcategories,
  seedDefaults,
} from "./services/category.service.js";
import { detectInternalTransfers } from "./services/transfer.service.js";
import { createCipher, deriveDatabaseKey, resolveEncryptionKey } from "./services/crypto.js";
import {
  applyPendingRestore,
  autoBackupIfDue,
  backupBeforeMigrating,
  backupDir,
} from "./services/backup.service.js";
import { getSettings } from "./services/settings.service.js";
import { createPlaidService } from "./services/plaid.service.js";
import { createSyncService } from "./services/sync.service.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const masterKey = resolveEncryptionKey(env);
  const cipher = createCipher(masterKey);
  const databaseKey = deriveDatabaseKey(masterKey);
  // A restore queued from the Data page is applied now, before the database is opened.
  const restored = applyPendingRestore(env.dataDir);
  if (restored) console.log(`restored the database from backup ${restored.name}`);
  const { db, sqlite, file } = createDb({
    dataDir: env.dataDir,
    key: databaseKey,
    nativeDir: env.PF_NATIVE_DIR,
  });
  // Backups an earlier version made as ordinary files are encrypted too.
  const encrypted = encryptExistingBackups(backupDir(env.dataDir), databaseKey, env.PF_NATIVE_DIR);
  if (encrypted > 0) console.log(`encrypted ${encrypted} earlier backup(s)`);
  // If this version changes the database structure, keep a copy of the data as it was first.
  const safety = await backupBeforeMigrating(db, env.dataDir, env.migrationsDir).catch(
    (error: unknown) => {
      throw new Error(
        `Could not back up before updating the database (${error instanceof Error ? error.message : "unknown error"}). Nothing was changed.`,
      );
    },
  );
  if (safety) console.log(`backup before update: ${safety.name}`);
  runMigrations(db, env.migrationsDir);
  // First run of a version with categories: create the starting categories and rules once.
  if (seedDefaults(db)) console.log("created the starting categories and rules");
  // Gas and Streaming, added after the first starting set (also puts past transactions into them).
  const added = ensureStarterAdditions(db);
  // Food & Drink keeps online orders; in-person purchases go to its Dining Out subcategory.
  const diningMoved = ensureDiningSplit(db);
  // Transfers > Credit (taxable income) and Transfers > Refund (not income).
  if (ensureTransferSubcategories(db)) console.log("added Credit and Refund under Transfers");
  if (diningMoved !== null) {
    console.log(
      `split Food & Drink into online and Dining Out (${diningMoved} transactions moved)`,
    );
  }
  if (added) {
    console.log(
      `added the Gas and Streaming categories (${added.recategorized} past transactions moved)`,
    );
  }
  // Bring Thrift Savings Plan accounts up to date: contributions that came due while the app was
  // closed, and balances at the newest fund prices. Repeated now and then while the app stays open.
  // Past balances are rebuilt at launch, on each new day (yesterday becomes history), and after
  // contributions are applied.
  let historyDay = "";
  const updateTsp = (): void => {
    try {
      const done = updateAllTspAccounts(db);
      if (done.applied > 0) console.log(`TSP: ${done.applied} contribution(s) turned into units`);
      const today = new Date().toISOString().slice(0, 10);
      if (done.applied > 0 || today !== historyDay) {
        rebuildAllTspHistories(db, tspAccountIds(db), today);
        historyDay = today;
      }
    } catch (error) {
      console.error("TSP update failed:", error instanceof Error ? error.message : error);
    }
  };
  updateTsp();
  setInterval(updateTsp, 60 * 60 * 1000).unref();
  // Pair up transfers between the user's own accounts (also covers data from an older version).
  const transfers = detectInternalTransfers(db);
  if (transfers > 0) console.log(`transfers between your own accounts found: ${transfers}`);

  const getGateway = createGatewayProvider(db, cipher);
  const sync = createSyncService({ db, cipher, getGateway });

  const app = createApp({
    db,
    port: env.PF_PORT,
    token: env.PF_TOKEN,
    version: env.PF_VERSION,
    cipher,
    recoveryKey: masterKey,
    getGateway,
    sync,
    staticDir: env.PF_STATIC_DIR,
    allowDevOrigin: env.PF_ALLOW_DEV_ORIGIN,
    dataDir: env.dataDir,
    migrationsDir: env.migrationsDir,
  });

  // Loopback only: the API is never reachable from other machines on the network.
  const server = app.listen(env.PF_PORT, "127.0.0.1", () => {
    console.log(`backend listening on 127.0.0.1:${env.PF_PORT} (database: ${file})`);

    // Look up the logos of connected banks not looked up yet (in the background, best effort).
    void createPlaidService({ db, cipher, getGateway })
      .refreshBranding()
      .then((n) => {
        if (n > 0) console.log(`institution logos looked up: ${n}`);
      })
      .catch(() => undefined);

    // A safety copy first (at most about twice a day), so a bad sync or a mistake can be undone.
    const settings = getSettings(db);
    const backedUp = settings.autoBackupEnabled
      ? autoBackupIfDue(db, env.dataDir, { keep: settings.backupsToKeep, minHours: 12 })
          .then((made) => {
            if (made) console.log(`automatic backup: ${made.name}`);
          })
          .catch((error: unknown) =>
            console.error(
              "automatic backup failed:",
              error instanceof Error ? error.message : "unknown error",
            ),
          )
      : Promise.resolve();
    // Then sync on launch, in the background so the window is usable immediately. Connections
    // synced within the cooldown (Settings) are skipped, so relaunching does not re-sync needlessly.
    backedUp
      .then(() => sync.runLaunchSync())
      .then((result) =>
        console.log(`launch sync: ${result.runs.length} run(s), ${result.skipped.length} skipped`),
      )
      .catch((error: unknown) =>
        console.error(
          "launch sync failed:",
          error instanceof Error ? error.message : "unknown error",
        ),
      );

    // Optional timed sync while the app stays open. Does nothing unless the interval setting is
    // above zero, and the setting is read again on every tick, so editing it applies at once.
    setInterval(() => {
      sync
        .runIntervalTick()
        .catch((error: unknown) =>
          console.error(
            "timed sync failed:",
            error instanceof Error ? error.message : "unknown error",
          ),
        );
    }, 60_000);
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(`backend failed to start: ${error.code ?? error.message}`);
    process.exit(1);
  });

  const shutdown = (): void => {
    server.close();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Safety net beside Tauri stopping us: if the app process dies abruptly, exit as well.
  if (env.PF_PARENT_PID) {
    const parentPid = env.PF_PARENT_PID;
    setInterval(() => {
      try {
        process.kill(parentPid, 0); // signal 0 only checks that the process exists
      } catch {
        console.log("parent process gone, exiting");
        shutdown();
      }
    }, 2000);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "backend failed to start");
  process.exit(1);
});
