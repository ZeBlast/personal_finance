import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { accounts } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { listAccounts } from "../services/account.service.js";
import {
  addManualCreditLimit,
  creditLimitView,
  deleteCreditLimitEntry,
  updateCreditLimitEntry,
} from "../services/credit-limit.service.js";
import { getSettings } from "../services/settings.service.js";
import { notFound } from "../utils/errors.js";

const idParam = z.coerce.number().int().positive();

/** Whole minor units (cents), positive, and below a sanity ceiling. */
const limitMinor = z.number().int().min(1).max(100_000_000_000);
const effectiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const note = z.string().max(200).nullable();

const addBody = z.object({ limitMinor, effectiveDate, note: note.optional() }).strict();
const editBody = z
  .object({
    limitMinor: limitMinor.optional(),
    effectiveDate: effectiveDate.optional(),
    note: note.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." });

export function accountsRoutes(db: AppDb): Router {
  const router = Router();

  // Accounts from connections in the active Plaid environment, plus manual accounts.
  router.get("/accounts", (_req, res) => {
    const environment = getSettings(db).plaidEnvironment;
    res.json(
      listAccounts(db).filter((a) => a.itemId === null || a.connectionEnvironment === environment),
    );
  });

  const requireAccount = (id: number): void => {
    const account = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, id)).get();
    if (!account) throw notFound("That account");
  };

  router.get("/accounts/:id/credit-limits", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    requireAccount(id);
    res.json(creditLimitView(db, id));
  });

  // Manual entries, including backdated ones. Every change answers with the recalculated history.
  router.post("/accounts/:id/credit-limits", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    res.status(201).json(addManualCreditLimit(db, id, addBody.parse(req.body)));
  });

  router.patch("/credit-limits/:id", (req, res) => {
    res.json(updateCreditLimitEntry(db, idParam.parse(req.params["id"]), editBody.parse(req.body)));
  });

  router.delete("/credit-limits/:id", (req, res) => {
    res.json(deleteCreditLimitEntry(db, idParam.parse(req.params["id"])));
  });

  return router;
}
