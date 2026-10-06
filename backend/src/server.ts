import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb, runMigrations } from "./db/client.js";
import { createGatewayProvider } from "./plaid/provider.js";
import { seedDefaults } from "./services/category.service.js";
import { createCipher, resolveEncryptionKey } from "./services/crypto.js";
import { applyPendingRestore, autoBackupIfDue } from "./services/backup.service.js";
import { getSettings } from "./services/settings.service.js";
import { createSyncService } from "./services/sync.service.js";

function main(): void {
  const env = loadEnv();
  const cipher = createCipher(resolveEncryptionKey(env));
  // A restore queued from the Data page is applied now, before the database is opened.
  const restored = applyPendingRestore(env.dataDir);
  if (restored) console.log(`restored the database from backup ${restored.name}`);
  const { db, sqlite, file } = createDb({ dataDir: env.dataDir, nativeDir: env.PF_NATIVE_DIR });
  runMigrations(db, env.migrationsDir);
  // First run of a version with categories: create the starting categories and rules once.
  if (seedDefaults(db)) console.log("created the starting categories and rules");

  const getGateway = createGatewayProvider(db, cipher);
  const sync = createSyncService({ db, cipher, getGateway });

  const app = createApp({
    db,
    port: env.PF_PORT,
    token: env.PF_TOKEN,
    version: env.PF_VERSION,
    cipher,
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

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "backend failed to start");
  process.exit(1);
}
