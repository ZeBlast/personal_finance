import { Router } from "express";
import {
  categoryTrends,
  TREND_FLOWS,
  TREND_INTERVALS,
} from "../services/category-trends.service.js";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  calendarMonth,
  DATE_BASES,
  GROUPS,
  overview,
  summarize,
} from "../services/analytics.service.js";
import {
  budgetMonth,
  copyBudgets,
  createBudget,
  deleteBudget,
  updateBudget,
} from "../services/budget.service.js";
import { spendingMonitor } from "../services/monitor.service.js";
import { getSettings } from "../services/settings.service.js";
import {
  createTag,
  deleteTag,
  listTags,
  setTransactionTags,
  transactionTagList,
  updateTag,
} from "../services/tag.service.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM");
const idParam = z.coerce.number().int().positive();
const flag = z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true");
const amountMinor = z.number().int().min(1).max(100_000_000_000);

const summaryQuery = z.object({
  from: date,
  to: date,
  groupBy: z.enum(GROUPS).default("none"),
  accountId: z.coerce.number().int().positive().optional(),
  /** One bank's accounts (its name), or "manual" for accounts kept by hand. */
  institution: z.string().min(1).max(200).optional(),
  category: z.union([z.literal("none"), z.coerce.number().int().positive()]).optional(),
  merchant: z.string().max(200).optional(),
  tagId: z.coerce.number().int().positive().optional(),
  rollupToParent: flag.optional(),
  includeTransfers: flag.optional(),
  includePending: flag.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  fill: flag.optional(),
});

const calendarQuery = z.object({
  month,
  accountId: z.coerce.number().int().positive().optional(),
  dateBasis: z.enum(DATE_BASES).optional(),
});

const budgetCreate = z
  .object({ categoryId: z.number().int().positive(), month, amountMinor })
  .strict();
const budgetUpdate = z.object({ amountMinor }).strict();
const budgetCopy = z.object({ fromMonth: month, toMonth: month }).strict();

export function analyticsRoutes(db: AppDb): Router {
  const router = Router();
  const environment = (): string => getSettings(db).plaidEnvironment;

  /**
   * Spending and income for any period, grouped by day, week, month, category, merchant, account or
   * institution. Most widgets are just a view of this one query, so a new chart rarely needs a new
   * endpoint.
   */
  /** Spending by category over time, for the category explorer. */
  router.get("/analytics/category-trends", (req, res) => {
    const ids = z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").filter(Boolean).map(Number) : []))
      .pipe(z.array(z.number().int().min(0)).max(200));
    const q = z
      .object({
        from: z.string(),
        to: z.string(),
        interval: z.enum(TREND_INTERVALS).default("month"),
        categories: ids,
        accounts: ids,
        split: z.enum(["0", "1"]).default("0"),
        pending: z.enum(["0", "1"]).default("1"),
        dateBasis: z.enum(DATE_BASES).optional(),
        flow: z.enum(TREND_FLOWS).default("out"),
      })
      .parse(req.query);
    res.json(
      categoryTrends(db, {
        ...q,
        splitSubcategories: q.split === "1",
        includePending: q.pending === "1",
        environment: getSettings(db).plaidEnvironment,
      }),
    );
  });

  /** A spending monitor: this month so far against recent months, narrowed any of four ways. */
  router.get("/analytics/monitor", (req, res) => {
    const q = z
      .object({
        category: z.coerce.number().int().positive().optional(),
        accountId: z.coerce.number().int().positive().optional(),
        merchant: z.string().max(200).optional(),
        tag: z.string().max(80).optional(),
        today: date.optional(),
      })
      .parse(req.query);
    res.json(spendingMonitor(db, q, q.today));
  });

  // ---- Tags ----

  const tagBody = z
    .object({
      name: z.string().trim().min(1).max(80),
      color: z.string().max(20).nullable().optional(),
    })
    .strict();
  router.get("/tags", (_req, res) => {
    res.json(listTags(db));
  });
  router.post("/tags", (req, res) => {
    res.status(201).json(createTag(db, tagBody.parse(req.body)));
  });
  router.put("/tags/:id", (req, res) => {
    res.json(updateTag(db, idParam.parse(req.params["id"]), tagBody.parse(req.body)));
  });
  router.delete("/tags/:id", (req, res) => {
    deleteTag(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });
  router.get("/transactions/:id/tags", (req, res) => {
    res.json(transactionTagList(db, idParam.parse(req.params["id"])));
  });
  router.put("/transactions/:id/tags", (req, res) => {
    const body = z
      .object({ tagIds: z.array(z.number().int().positive()).max(50) })
      .strict()
      .parse(req.body);
    res.json(setTransactionTags(db, idParam.parse(req.params["id"]), body.tagIds));
  });

  router.get("/analytics/summary", (req, res) => {
    const q = summaryQuery.parse(req.query);
    res.json(
      summarize(db, {
        from: q.from,
        to: q.to,
        groupBy: q.groupBy,
        accountId: q.accountId,
        institution: q.institution,
        category: q.category,
        merchant: q.merchant,
        tagId: q.tagId,
        rollupToParent: q.rollupToParent,
        includeTransfers: q.includeTransfers ?? false,
        includePending: q.includePending ?? true,
        limit: q.limit,
        fill: q.fill ?? false,
        environment: environment(),
      }),
    );
  });

  router.get("/analytics/calendar", (req, res) => {
    const q = calendarQuery.parse(req.query);
    res.json(calendarMonth(db, q.month, environment(), q.accountId, q.dateBasis));
  });

  /** Current balances rolled up into assets, debts and net worth, plus credit-card utilization. */
  router.get("/analytics/overview", (_req, res) => {
    res.json(overview(db));
  });

  // ---- Budgets ----

  router.get("/budgets", (req, res) => {
    res.json(budgetMonth(db, month.parse(req.query["month"]), environment()));
  });

  router.post("/budgets", (req, res) => {
    res.status(201).json(createBudget(db, budgetCreate.parse(req.body), environment()));
  });

  router.post("/budgets/copy", (req, res) => {
    const body = budgetCopy.parse(req.body);
    res.json(copyBudgets(db, body.fromMonth, body.toMonth));
  });

  router.patch("/budgets/:id", (req, res) => {
    const body = budgetUpdate.parse(req.body);
    res.json(updateBudget(db, idParam.parse(req.params["id"]), body.amountMinor, environment()));
  });

  router.delete("/budgets/:id", (req, res) => {
    deleteBudget(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  return router;
}
