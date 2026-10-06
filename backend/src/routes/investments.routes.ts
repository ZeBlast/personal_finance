import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  addManualTransaction,
  deleteManualTransaction,
  importHoldingsCsv,
  importTransactionsCsv,
} from "../services/investment-import.service.js";
import { ASSET_CLASSES, TSP_FUNDS } from "../services/investment-funds.js";
import {
  createManualAccount,
  deleteManualAccount,
  setManualHoldings,
} from "../services/investment.service.js";
import {
  portfolioHistory,
  portfolioHoldings,
  portfolioOverview,
  portfolioTransactions,
} from "../services/portfolio.service.js";

const idParam = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const flag = z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true");
const optionalAccount = z.object({ accountId: idParam.optional() });

const minor = z.number().int().min(0).max(100_000_000_000_000);
const text = (max: number) => z.string().trim().max(max);

const accountBody = z
  .object({
    name: text(80).min(1),
    officialName: text(120).nullable().optional(),
    subtype: text(40).nullable().optional(),
  })
  .strict();

const holdingBody = z
  .object({
    symbol: text(40).nullable().optional(),
    name: text(120).nullable().optional(),
    assetClass: z.enum(ASSET_CLASSES).nullable().optional(),
    quantity: z.number().min(0).max(1e15),
    price: z.number().min(0).max(1e12).nullable().optional(),
    valueMinor: minor.nullable().optional(),
    costBasisMinor: minor.nullable().optional(),
    asOf: date.nullable().optional(),
  })
  .strict();

const holdingsBody = z.object({ holdings: z.array(holdingBody).max(500) }).strict();

const csvBody = z.object({ csv: z.string().min(1).max(900_000) }).strict();

const transactionBody = z
  .object({
    date,
    type: text(20).min(1),
    symbol: text(40).nullable().optional(),
    name: text(120).nullable().optional(),
    description: text(200).nullable().optional(),
    quantity: z.number().min(0).max(1e15).nullable().optional(),
    price: z.number().min(0).max(1e12).nullable().optional(),
    /** Positive cash amount; for transfer/other, negative means money out. */
    amountMinor: z
      .number()
      .int()
      .min(-100_000_000_000_000)
      .max(100_000_000_000_000)
      .nullable()
      .optional(),
    feesMinor: minor.nullable().optional(),
  })
  .strict();

const listQuery = z.object({
  accountId: idParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function investmentsRoutes(db: AppDb): Router {
  const router = Router();
  const now = (): string => new Date().toISOString();

  router.get("/investments/overview", (req, res) => {
    res.json(portfolioOverview(db, optionalAccount.parse(req.query).accountId));
  });

  router.get("/investments/holdings", (req, res) => {
    const query = optionalAccount.extend({ combine: flag.optional() }).parse(req.query);
    res.json(portfolioHoldings(db, { accountId: query.accountId, combine: query.combine }));
  });

  router.get("/investments/history", (req, res) => {
    const query = optionalAccount
      .extend({ from: date.optional(), to: date.optional() })
      .parse(req.query);
    res.json(portfolioHistory(db, query));
  });

  router.get("/investments/transactions", (req, res) => {
    const query = listQuery.parse(req.query);
    res.json(portfolioTransactions(db, query));
  });

  /** Preset funds and the asset classes, for the entry forms. */
  router.get("/investments/funds", (_req, res) => {
    res.json({
      assetClasses: ASSET_CLASSES,
      funds: TSP_FUNDS.map((f) => ({ symbol: f.symbol, name: f.name, assetClass: f.assetClass })),
    });
  });

  router.post("/investments/accounts", (req, res) => {
    const body = accountBody.parse(req.body);
    const id = createManualAccount(db, body, now());
    res.status(201).json({ id });
  });

  router.delete("/investments/accounts/:id", (req, res) => {
    deleteManualAccount(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  router.put("/investments/accounts/:id/holdings", (req, res) => {
    const body = holdingsBody.parse(req.body);
    res.json(setManualHoldings(db, idParam.parse(req.params["id"]), body.holdings, now()));
  });

  router.post("/investments/accounts/:id/import/holdings", (req, res) => {
    const body = csvBody.parse(req.body);
    res.json(importHoldingsCsv(db, idParam.parse(req.params["id"]), body.csv, now()));
  });

  router.post("/investments/accounts/:id/import/transactions", (req, res) => {
    const body = csvBody.parse(req.body);
    res.json(importTransactionsCsv(db, idParam.parse(req.params["id"]), body.csv, now()));
  });

  router.post("/investments/accounts/:id/transactions", (req, res) => {
    const body = transactionBody.parse(req.body);
    const id = addManualTransaction(db, idParam.parse(req.params["id"]), body, now());
    res.status(201).json({ id });
  });

  router.delete("/investments/transactions/:id", (req, res) => {
    deleteManualTransaction(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  return router;
}
