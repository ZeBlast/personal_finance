import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  cashbackSummary,
  getCashbackRules,
  setCashbackRules,
} from "../services/cashback.service.js";

const idParam = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const rulesBody = z
  .object({
    rules: z
      .array(
        z
          .object({
            categoryId: z.number().int().positive().nullable(),
            ratePercent: z.number().min(0).max(100),
            onlineOnly: z.boolean().optional(),
            merchant: z.string().max(100).nullable().optional(),
            exclude: z.boolean().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

const summaryQuery = z.object({
  from: date,
  to: date,
  accountId: z.coerce.number().int().positive().optional(),
});

/** Cashback rates for credit cards, and what the cards have earned. */
export function cashbackRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/accounts/:id/cashback-rules", (req, res) => {
    res.json(getCashbackRules(db, idParam.parse(req.params["id"])));
  });

  /** Replaces the card's whole set of rates (a category, or null for everything else). */
  router.put("/accounts/:id/cashback-rules", (req, res) => {
    res.json(
      setCashbackRules(db, idParam.parse(req.params["id"]), rulesBody.parse(req.body).rules),
    );
  });

  router.get("/cashback/summary", (req, res) => {
    res.json(cashbackSummary(db, summaryQuery.parse(req.query)));
  });

  return router;
}
