import { Router } from "express";
import type { AppDb } from "../db/client.js";
import { sql } from "drizzle-orm";

export function healthRoutes(db: AppDb, version: string): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    let database = true;
    try {
      db.get(sql`select 1`);
    } catch {
      database = false;
    }
    res.status(database ? 200 : 503).json({ ok: database, database, version });
  });
  return router;
}
