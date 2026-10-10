import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { assignMerchant, listMerchants } from "../services/merchant.service.js";

const listQuery = z.object({
  q: z.string().max(200).optional(),
  assigned: z
    .union([z.enum(["all", "assigned", "unassigned"]), z.coerce.number().int().positive()])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const assignBody = z
  .object({
    merchant: z.string().min(1).max(200),
    categoryId: z.number().int().positive().nullable(),
    overrideManual: z.boolean().optional(),
  })
  .strict();

/** Merchants and which category each is assigned to. */
export function merchantsRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/merchants", (req, res) => {
    res.json(listMerchants(db, listQuery.parse(req.query)));
  });

  /** Assign a merchant to a category (or, with a null category, remove the assignment). */
  router.put("/merchants/assignment", (req, res) => {
    res.json(assignMerchant(db, assignBody.parse(req.body)));
  });

  return router;
}
