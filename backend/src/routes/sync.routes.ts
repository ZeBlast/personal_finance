import { Router } from "express";
import { z } from "zod";
import type { SyncService } from "../services/sync.service.js";

const body = z.object({ itemId: z.number().int().positive().optional() }).default({});

export function syncRoutes(sync: SyncService): Router {
  const router = Router();

  /**
   * The Sync button. Always runs, ignoring the launch cooldown. Resolves when the sync is done
   * (or joins a sync that is already running for the same connection).
   */
  router.post("/sync", async (req, res) => {
    const { itemId } = body.parse(req.body);
    if (itemId !== undefined) {
      res.json({ runs: [await sync.syncItem(itemId, "manual")], skipped: [] });
      return;
    }
    res.json(await sync.syncAll({ trigger: "manual", force: true }));
  });

  router.get("/sync/status", (_req, res) => {
    res.json(sync.status());
  });

  return router;
}
