import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { creditUtilizationHistory } from "../services/credit-utilization.service.js";
import { dismissSeries, recurringReport, restoreSeries } from "../services/recurring.service.js";
import { isRealDate } from "../utils/dates.js";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isRealDate, "Use a real date");
const flag = z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true");
const keyBody = z
  .object({ key: z.string().min(3).max(220), merchant: z.string().max(200).optional() })
  .strict();

/** Patterns found in the data: recurring charges, and credit card utilization over time. */
export function insightsRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/insights/recurring", (req, res) => {
    const query = z
      .object({ includeDismissed: flag.optional(), asOf: date.optional() })
      .parse(req.query);
    res.json(recurringReport(db, { includeDismissed: query.includeDismissed, today: query.asOf }));
  });

  /** "This is not recurring": hides one series from the insights. */
  router.post("/insights/recurring/dismiss", (req, res) => {
    const body = keyBody.parse(req.body);
    dismissSeries(db, body.key, body.merchant ?? body.key);
    res.json(recurringReport(db, { includeDismissed: true }));
  });

  router.post("/insights/recurring/restore", (req, res) => {
    restoreSeries(db, keyBody.parse(req.body).key);
    res.json(recurringReport(db, { includeDismissed: true }));
  });

  router.get("/insights/credit-utilization", (req, res) => {
    const query = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    res.json(creditUtilizationHistory(db, query));
  });

  return router;
}
