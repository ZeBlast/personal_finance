import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  backupDir,
  cancelRestore,
  createBackup,
  deleteBackup,
  listBackups,
  pendingRestore,
  stageRestore,
} from "../services/backup.service.js";
import {
  checkIntegrity,
  diagnostics,
  recentSyncProblems,
} from "../services/diagnostics.service.js";
import { EXPORT_KINDS, exportDir, runExport } from "../services/export.service.js";
import { netWorthHistory } from "../services/networth-history.service.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** How many migrations this version of the app knows, so a backup from a newer version is refused. */
function knownMigrations(migrationsDir: string): number {
  try {
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
    ) as { entries?: unknown[] };
    return journal.entries?.length ?? 0;
  } catch {
    return 0;
  }
}

/** History, backups, exports, and diagnostics: everything about the app's own data. */
export function dataRoutes(options: {
  db: AppDb;
  dataDir: string;
  migrationsDir: string;
  version: string;
}): Router {
  const { db, dataDir, migrationsDir, version } = options;
  const router = Router();

  router.get("/analytics/net-worth-history", (req, res) => {
    const query = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    res.json(netWorthHistory(db, query));
  });

  router.get("/backups", (_req, res) => {
    res.json({
      directory: backupDir(dataDir),
      backups: listBackups(dataDir),
      pendingRestore: pendingRestore(dataDir),
    });
  });

  router.post("/backups", async (_req, res) => {
    res.status(201).json(await createBackup(db, dataDir, "manual"));
  });

  router.delete("/backups/:name", (req, res) => {
    deleteBackup(dataDir, String(req.params["name"]));
    res.status(204).end();
  });

  /** Queues a restore; the swap happens the next time the app starts. */
  router.post("/backups/:name/restore", (req, res) => {
    res.json(stageRestore(db, dataDir, String(req.params["name"]), knownMigrations(migrationsDir)));
  });

  router.delete("/restore/pending", (_req, res) => {
    cancelRestore(dataDir);
    res.status(204).end();
  });

  router.post("/exports", (req, res) => {
    const body = z
      .object({ kind: z.enum(EXPORT_KINDS) })
      .strict()
      .parse(req.body);
    res.status(201).json({ ...runExport(db, dataDir, body.kind), directory: exportDir(dataDir) });
  });

  router.get("/diagnostics", (_req, res) => {
    res.json(diagnostics(db, { dataDir, version }));
  });

  /** The thorough check (verifies every index too). */
  router.post("/diagnostics/integrity-check", (_req, res) => {
    res.json(checkIntegrity(db, true));
  });

  router.get("/sync/history", (req, res) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(30) })
      .parse(req.query);
    res.json(recentSyncProblems(db, query.limit));
  });

  return router;
}
