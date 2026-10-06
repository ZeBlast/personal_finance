import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { getSettings } from "../services/settings.service.js";
import {
  getTransaction,
  listTransactions,
  SORTS,
  updateTransaction,
} from "../services/transaction.service.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  accountId: z.coerce.number().int().positive().optional(),
  from: date.optional(),
  to: date.optional(),
  pending: z.enum(["true", "false"]).optional(),
  q: z.string().max(200).optional(),
  category: z.union([z.literal("none"), z.coerce.number().int().positive()]).optional(),
  sort: z.enum(SORTS).optional(),
});

/** The fields a user may change. Everything else comes from the bank and cannot be edited. */
const patchBody = z
  .object({
    categoryId: z.number().int().positive().nullable().optional(),
    merchant: z.string().max(200).nullable().optional(),
    recipient: z.string().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." });

export function transactionsRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/transactions", (req, res) => {
    const parsed = listQuery.parse(req.query);
    res.json(
      listTransactions(db, {
        ...parsed,
        pending: parsed.pending === undefined ? undefined : parsed.pending === "true",
        environment: getSettings(db).plaidEnvironment,
      }),
    );
  });

  router.get("/transactions/:id", (req, res) => {
    res.json(getTransaction(db, idParam.parse(req.params["id"])));
  });

  router.patch("/transactions/:id", (req, res) => {
    const body = patchBody.parse(req.body);
    res.json(updateTransaction(db, idParam.parse(req.params["id"]), body));
  });

  return router;
}
