import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { safetyNet } from "../services/safety-net.service.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/**
 * The planning tools that read across the others: the safety net, can I afford it, the month
 * plan, the year ahead and the long-range outlook. Each only reads; nothing here changes data.
 */
export function planToolsRoutes(db: AppDb): Router {
  const router = Router();

  /** How many months the cash would cover essential spending. */
  router.get("/safety-net", (req, res) => {
    const q = z.object({ today: day.optional() }).parse(req.query);
    res.json(safetyNet(db, q));
  });

  return router;
}
