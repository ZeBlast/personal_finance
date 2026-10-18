import express, { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  addAttachment,
  deleteAttachment,
  getAttachmentFile,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
} from "../services/attachment.service.js";
import { clearBillSettings, listBills, setBillSettings } from "../services/bills.service.js";
import { cashForecast, MAX_FORECAST_DAYS } from "../services/forecast.service.js";
import { monthReport } from "../services/report.service.js";
import { detectPaychecks } from "../services/paycheck.service.js";
import { dailyBrief } from "../services/brief.service.js";
import { clearDebtTerms, debtOverview, setDebtTerms } from "../services/debt.service.js";
import { createGoal, deleteGoal, listGoals, updateGoal } from "../services/goal.service.js";
import {
  dismissDuplicate,
  listDuplicates,
  reviewQueue,
  uncategorized,
  setReviewed,
} from "../services/review.service.js";
import {
  setSubscriptionReview,
  SUBSCRIPTION_STATUSES,
  subscriptionReview,
} from "../services/subscriptions.service.js";
import { AppError } from "../utils/errors.js";

const idParam = z.coerce.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const billBody = z
  .object({
    closingDay: z.number().int().min(1).max(31),
    dueDay: z.number().int().min(1).max(31),
    minimumMinor: z.number().int().min(0).max(100_000_000_000).nullable().default(null),
    autopay: z.boolean().default(false),
  })
  .strict();

const subscriptionBody = z
  .object({
    merchant: z.string().min(1).max(200),
    status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
    note: z.string().max(1000).nullable().optional(),
  })
  .strict();

/** Planning and tidying: forecast, card bills, subscriptions, the month report, files, review. */
export function planningRoutes(db: AppDb): Router {
  const router = Router();

  const goalBody = z
    .object({
      name: z.string().trim().min(1).max(80),
      targetMinor: z.number().int().min(1).max(100_000_000_000),
      targetDate: day.nullable().optional(),
      savedMinor: z.number().int().min(0).max(100_000_000_000).optional(),
      accountIds: z.array(z.number().int().positive()).max(20).optional(),
      accountAmounts: z
        .record(z.string().regex(/^\d+$/), z.number().int().min(0).max(100_000_000_000))
        .optional(),
      color: z.string().max(20).nullable().optional(),
    })
    .strict();

  /** Savings goals, with progress and what a month it takes. */
  router.get("/goals", (_req, res) => {
    res.json(listGoals(db));
  });
  router.post("/goals", (req, res) => {
    res.status(201).json(createGoal(db, goalBody.parse(req.body)));
  });
  router.put("/goals/:id", (req, res) => {
    res.json(updateGoal(db, idParam.parse(req.params["id"]), goalBody.parse(req.body)));
  });
  router.delete("/goals/:id", (req, res) => {
    deleteGoal(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  /** Regular pay found in the income, with the year's projection. */
  router.get("/paychecks", (req, res) => {
    const q = z
      .object({ year: z.coerce.number().int().min(2000).max(2100).optional() })
      .parse(req.query);
    res.json(detectPaychecks(db, { year: q.year }));
  });

  /** The daily brief: safe to spend until the next income, and where it comes from. */
  router.get("/brief", (req, res) => {
    const q = z
      .object({
        today: day.optional(),
        bufferMinor: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
      })
      .parse(req.query);
    res.json(dailyBrief(db, q));
  });

  /** Cards and loans, and a plan to pay them off with something extra each month. */
  router.get("/debt", (req, res) => {
    const q = z
      .object({
        extraMinor: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
        strategy: z.enum(["avalanche", "snowball"]).optional(),
      })
      .parse(req.query);
    res.json(debtOverview(db, q));
  });
  router.put("/debt/:accountId", (req, res) => {
    const body = z
      .object({
        aprBps: z.number().int().min(0).max(10_000),
        minimumMinor: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    setDebtTerms(db, idParam.parse(req.params["accountId"]), body);
    res.json(debtOverview(db));
  });
  router.delete("/debt/:accountId", (req, res) => {
    clearDebtTerms(db, idParam.parse(req.params["accountId"]));
    res.status(204).end();
  });

  router.get("/forecast", (req, res) => {
    const q = z
      .object({
        days: z.coerce.number().int().min(7).max(MAX_FORECAST_DAYS).optional(),
        today: day.optional(),
      })
      .parse(req.query);
    res.json(cashForecast(db, q));
  });

  router.get("/bills", (req, res) => {
    const q = z.object({ today: day.optional() }).parse(req.query);
    res.json(listBills(db, q.today));
  });

  router.put("/accounts/:id/bill", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    setBillSettings(db, id, billBody.parse(req.body));
    res.json(listBills(db).find((b) => b.accountId === id) ?? null);
  });

  router.delete("/accounts/:id/bill", (req, res) => {
    clearBillSettings(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  router.get("/subscriptions", (_req, res) => {
    res.json(subscriptionReview(db));
  });

  router.put("/subscriptions/:key", (req, res) => {
    const key = z.string().min(1).max(500).parse(req.params["key"]);
    setSubscriptionReview(db, key, subscriptionBody.parse(req.body));
    res.json(subscriptionReview(db));
  });

  router.get("/reports/month", (req, res) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
    res.json(monthReport(db, q.month));
  });

  // ---- Files attached to transactions ----------------------------------------------------------

  router.get("/transactions/:id/attachments", (req, res) => {
    res.json(listAttachments(db, idParam.parse(req.params["id"])));
  });

  /** The file is the request body; its name comes in the `name` query parameter. */
  router.post(
    "/transactions/:id/attachments",
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES + 1024 }),
    (req, res) => {
      const id = idParam.parse(req.params["id"]);
      const name = z.string().min(1).max(300).parse(req.query["name"]);
      if (!Buffer.isBuffer(req.body)) {
        throw new AppError(400, "empty_file", "Send the file as the request body.");
      }
      const mime = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
      res.status(201).json(addAttachment(db, id, { name, mime, data: req.body }));
    },
  );

  router.get("/attachments/:id", (req, res) => {
    const file = getAttachmentFile(db, idParam.parse(req.params["id"]));
    res.setHeader("content-type", file.mime);
    res.setHeader("content-disposition", `inline; filename="${encodeURIComponent(file.name)}"`);
    // Never let the browser treat an uploaded file as something else (such as a web page).
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:");
    res.send(file.data);
  });

  router.delete("/attachments/:id", (req, res) => {
    deleteAttachment(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  // ---- Duplicates and the review queue ---------------------------------------------------------

  router.get("/duplicates", (_req, res) => {
    res.json(listDuplicates(db));
  });

  router.post("/duplicates/dismiss", (req, res) => {
    const body = z.object({ a: idParam, b: idParam }).strict().parse(req.body);
    dismissDuplicate(db, body.a, body.b);
    res.status(204).end();
  });

  router.get("/review", (_req, res) => {
    res.json(reviewQueue(db));
  });

  /** Every transaction without a category (not just recent ones), to categorize from Review. */
  router.get("/review/uncategorized", (_req, res) => {
    res.json(uncategorized(db));
  });

  router.post("/review/mark", (req, res) => {
    const body = z
      .object({ ids: z.array(idParam).min(1).max(1000), reviewed: z.boolean().default(true) })
      .strict()
      .parse(req.body);
    res.json({ changed: setReviewed(db, body.ids, body.reviewed) });
  });

  return router;
}
