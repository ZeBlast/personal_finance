import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  addManualPrice,
  fetchFundPrices,
  importFundPriceCsv,
  latestPrices,
  listFundPrices,
  MAX_HISTORY_DAYS,
  PRICE_SOURCES,
  type PriceSource,
} from "../services/fund-price.service.js";
import { importActivityCsv } from "../services/tsp-activity.service.js";
import {
  rebuildAllTspHistories,
  rebuildTspBalanceHistory,
} from "../services/tsp-history.service.js";
import { TSP_FUNDS } from "../services/investment-funds.js";
import {
  applyDueContributions,
  createContribution,
  createTspAccount,
  deleteContribution,
  FREQUENCIES,
  getTspSettings,
  MATCH_PLANS,
  refreshTspValues,
  setAllocations,
  updateContribution,
  tspAccountIds,
  updateAllTspAccounts,
} from "../services/tsp.service.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const idParam = z.coerce.number().int().positive();

const allocationBody = z
  .object({ symbol: z.string().min(1).max(40), percent: z.number().min(0).max(100) })
  .strict();
const allocationsBody = z.object({ allocations: z.array(allocationBody).max(20) }).strict();
const createAccountBody = z
  .object({ name: z.string().min(1).max(80), allocations: z.array(allocationBody).max(20) })
  .strict();
const contributionBody = z
  .object({
    amountMinor: z.number().int().min(1).max(100_000_000),
    frequency: z.enum(FREQUENCIES),
    startDate: date,
    endDate: date.nullable().optional(),
    dayOfMonth: z.number().int().min(-1).max(31).nullable().optional(),
    secondDayOfMonth: z.number().int().min(-1).max(31).nullable().optional(),
    matchPlan: z.enum(MATCH_PLANS).nullable().optional(),
    payMinor: z.number().int().min(1).max(100_000_000).nullable().optional(),
    matchPercent: z.number().min(0).max(200).nullable().optional(),
    matchUpToPercent: z.number().min(0).max(100).nullable().optional(),
    autoPercent: z.number().min(0).max(100).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
const priceBody = z
  .object({ symbol: z.string().min(1).max(40), date, price: z.number().positive().max(100_000) })
  .strict();
const activityBody = z
  .object({ csv: z.string().min(1).max(5_000_000), updateHoldings: z.boolean().default(false) })
  .strict();
const importBody = z.object({ csv: z.string().min(1).max(5_000_000) }).strict();
const fetchBody = z
  .object({
    source: z.enum(PRICE_SOURCES as [PriceSource, ...PriceSource[]]).optional(),
    days: z.number().int().min(1).max(MAX_HISTORY_DAYS).optional(),
    since: date.optional(),
  })
  .strict();

/** Thrift Savings Plan accounts kept by hand, and the daily fund prices they depend on. */
export function tspRoutes(db: AppDb): Router {
  const router = Router();
  const now = (): string => new Date().toISOString();
  /**
   * After prices, settings, or contributions change, bring every TSP account up to date, and
   * rebuild the past balances they imply (new units or new prices change those too).
   */
  const refresh = (): { applied: number; refreshed: number; waiting: number } => {
    const result = updateAllTspAccounts(db, { now: now() });
    rebuildAllTspHistories(db, tspAccountIds(db), now().slice(0, 10));
    return result;
  };

  router.get("/tsp/funds", (_req, res) => {
    const latest = latestPrices(db);
    res.json(
      TSP_FUNDS.map((f) => ({
        symbol: f.symbol,
        code: f.code,
        name: f.name,
        assetClass: f.assetClass,
        latest: latest.get(f.symbol) ?? null,
      })),
    );
  });

  router.post("/tsp/accounts", (req, res) => {
    const body = createAccountBody.parse(req.body);
    const id = createTspAccount(db, body, now());
    res.status(201).json({ id, settings: getTspSettings(db, id) });
  });

  router.get("/accounts/:id/tsp", (req, res) => {
    res.json(getTspSettings(db, idParam.parse(req.params["id"])));
  });

  router.put("/accounts/:id/tsp/allocations", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    setAllocations(db, id, allocationsBody.parse(req.body).allocations);
    refresh();
    res.json(getTspSettings(db, id));
  });

  router.post("/accounts/:id/tsp/contributions", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    // A new contribution is always active; only the editing route changes that.
    const { active: _ignored, ...input } = contributionBody.parse(req.body);
    void _ignored;
    const created = createContribution(db, id, input, now());
    const result = refresh();
    res.status(201).json({ contribution: created, ...result });
  });

  router.put("/tsp/contributions/:id", (req, res) => {
    const updated = updateContribution(
      db,
      idParam.parse(req.params["id"]),
      contributionBody.parse(req.body),
      now(),
    );
    refresh();
    res.json(updated);
  });

  router.delete("/tsp/contributions/:id", (req, res) => {
    deleteContribution(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  /** Turns anything that has come due into units and refreshes the value. */
  router.post("/accounts/:id/tsp/apply", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    const applied = applyDueContributions(db, { accountId: id, now: now() });
    const refreshed = refreshTspValues(db, { accountId: id, now: now() });
    if (applied.applied > 0) rebuildTspBalanceHistory(db, id, now().slice(0, 10));
    res.json({ ...applied, refreshed });
  });

  router.get("/tsp/prices", (req, res) => {
    const q = z
      .object({ symbol: z.string().min(1), from: date.optional(), to: date.optional() })
      .parse(req.query);
    res.json(listFundPrices(db, q));
  });

  router.post("/tsp/prices", (req, res) => {
    const saved = addManualPrice(db, priceBody.parse(req.body), now());
    res.status(201).json({ price: saved, ...refresh() });
  });

  /** Reads a price file downloaded from tsp.gov (CSV). */
  router.post("/tsp/prices/import", (req, res) => {
    const summary = importFundPriceCsv(db, importBody.parse(req.body).csv, now());
    res.json({ ...summary, ...refresh() });
  });

  /** Records the TSP's Investment Activity Detail file as this account's contribution history. */
  router.post("/accounts/:id/tsp/activity/import", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    const body = activityBody.parse(req.body);
    const summary = importActivityCsv(db, id, body.csv, {
      updateHoldings: body.updateHoldings,
      now: now(),
    });
    const refreshed = refreshTspValues(db, { accountId: id, now: now() });
    const history = rebuildTspBalanceHistory(db, id, now().slice(0, 10));
    res.json({ ...summary, refreshed, history });
  });

  /** Tries to download recent prices; says plainly when the TSP's site does not allow it. */
  router.post("/tsp/prices/fetch", async (req, res) => {
    const body = fetchBody.parse(req.body ?? {});
    const summary = await fetchFundPrices(db, {
      ...(body.source ? { source: body.source } : {}),
      ...(body.days ? { days: body.days } : {}),
      ...(body.since ? { since: body.since } : {}),
    });
    res.json({ ...summary, ...refresh() });
  });

  return router;
}
