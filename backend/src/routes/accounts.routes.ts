import { eq } from "drizzle-orm";
import { addCredits, useCredits } from "../services/store-credit.service.js";
import { Router } from "express";
import { z } from "zod";
import { accounts } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { listAccounts, setAccountHidden } from "../services/account.service.js";
import {
  addManualCreditLimit,
  creditLimitView,
  deleteCreditLimitEntry,
  updateCreditLimitEntry,
} from "../services/credit-limit.service.js";
import {
  createManualBankAccount,
  deleteManualBankAccount,
  MANUAL_ACCOUNT_KINDS,
} from "../services/manual-transaction.service.js";
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

const hiddenBody = z.object({ hidden: z.boolean() }).strict();

const manualAccountBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(MANUAL_ACCOUNT_KINDS),
    openingBalanceMinor: z.number().int().min(-100_000_000_000).max(100_000_000_000).optional(),
    creditLimitMinor: limitMinor.optional(),
  })
  .strict();

const day = effectiveDate;
const cents = z.number().int().min(1).max(100_000_000_000);
const addCreditsBody = z
  .object({
    date: day,
    amountMinor: cents,
    description: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
const useCreditsBody = z
  .object({
    date: day,
    merchant: z.string().max(200).nullable().optional(),
    totalMinor: cents,
    creditMinor: cents,
    categoryId: z.number().int().positive().nullable().optional(),
    restAccountId: z.number().int().positive().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export function accountsRoutes(db: AppDb): Router {
  const router = Router();

  // Accounts from connections in the active Plaid environment, plus manual accounts.
  router.get("/accounts", (req, res) => {
    const environment = getSettings(db).plaidEnvironment;
    const includeHidden = req.query["includeHidden"] === "1";
    res.json(
      listAccounts(db, undefined, includeHidden).filter(
        (a) => a.itemId === null || a.connectionEnvironment === environment,
      ),
    );
  });

  /** Hides an account from balances, totals, charts and lists, or shows it again. */
  router.patch("/accounts/:id", (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params["id"]);
    res.json(setAccountHidden(db, id, hiddenBody.parse(req.body).hidden));
  });

  /** Creates an account kept by hand: cash, a checking or savings account, or a card. */
  router.post("/accounts/manual", (req, res) => {
    const body = manualAccountBody.parse(req.body);
    const id = createManualBankAccount(db, body, new Date().toISOString());
    res.status(201).json({ id });
  });

  /** Adds credits to a store credit (gift card) account. */
  router.post("/accounts/:id/credits/add", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    res
      .status(201)
      .json(addCredits(db, id, addCreditsBody.parse(req.body), new Date().toISOString()));
  });

  /** A purchase paid with store credit, alone or with real money for the rest. */
  router.post("/accounts/:id/credits/use", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    res
      .status(201)
      .json(useCredits(db, id, useCreditsBody.parse(req.body), new Date().toISOString()));
  });

  router.delete("/accounts/manual/:id", (req, res) => {
    deleteManualBankAccount(db, idParam.parse(req.params["id"]));
    res.status(204).end();
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
