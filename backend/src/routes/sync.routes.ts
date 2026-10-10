import { Router } from "express";
import { z } from "zod";
import type { SyncService } from "../services/sync.service.js";
import { AppError } from "../utils/errors.js";

const body = z.object({ itemId: z.number().int().positive().optional() }).default({});

export function syncRoutes(sync: SyncService): Router {
  const router = Router();

  /**
   * The Sync button. Ignores the launch cooldown, but not the minimum gap between syncs of a
   * connection. Resolves when the sync is done (or joins a sync already running for it).
   */
  router.post("/sync", async (req, res) => {
    const { itemId } = body.parse(req.body);
    if (itemId !== undefined) {
      const notBefore = sync.nextAllowedAt(itemId);
      if (notBefore) {
        const minutes = Math.max(1, Math.ceil((Date.parse(notBefore) - Date.now()) / 60_000));
        throw new AppError(
          429,
          "sync_too_soon",
          `This connection synced a moment ago. It can sync again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      }
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
