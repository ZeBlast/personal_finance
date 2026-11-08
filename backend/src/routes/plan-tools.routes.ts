import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { affordCheck } from "../services/afford.service.js";
import { MAX_FORECAST_DAYS } from "../services/forecast.service.js";
import { monthPlan } from "../services/month-plan.service.js";
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

  /** Whether a purchase from the bank accounts fits on a day, the earliest day it does, or how to save for it. */
  router.get("/afford", (req, res) => {
    const q = z
      .object({
        amountMinor: z.coerce.number().int().min(1).max(100_000_000_000),
        date: day.optional(),
        bufferMinor: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
        days: z.coerce.number().int().min(30).max(MAX_FORECAST_DAYS).optional(),
        today: day.optional(),
      })
      .parse(req.query);
    res.json(affordCheck(db, q));
  });

  /** A month's expected income next to everything it has to cover. */
  router.get("/month-plan", (req, res) => {
    const q = z
      .object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/, "Use YYYY-MM")
          .optional(),
        today: day.optional(),
      })
      .parse(req.query);
    res.json(monthPlan(db, q));
  });

  return router;
}
