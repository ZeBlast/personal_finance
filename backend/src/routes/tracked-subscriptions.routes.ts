import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  BILLINGS,
  createTrackedSubscription,
  deleteTrackedSubscription,
  listTrackedSubscriptions,
  setTrackedSubscriptionStatus,
  SUB_FREQUENCIES,
  updateTrackedSubscription,
} from "../services/tracked-subscriptions.service.js";

const idParam = z.coerce.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max).nullable().optional();

const body = z
  .object({
    name: z.string().max(120),
    amountMinor: z.number().int(),
    billing: z.enum(BILLINGS),
    frequency: z.enum(SUB_FREQUENCIES).nullable().optional(),
    repeatEvery: z.number().int().optional(),
    startDate: day,
    termMonths: z.number().int().nullable().optional(),
    accountId: z.number().int().positive().nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    email: text(200),
    username: text(200),
    website: text(300),
    notes: text(2000),
    recurringKey: text(500),
  })
  .strict();

/** Subscriptions the user keeps track of: added by hand, or found in the history with details. */
export function trackedSubscriptionsRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/tracked-subscriptions", (_req, res) => {
    res.json(listTrackedSubscriptions(db));
  });

  router.post("/tracked-subscriptions", (req, res) => {
    res.status(201).json(createTrackedSubscription(db, body.parse(req.body)));
  });

  router.put("/tracked-subscriptions/:id", (req, res) => {
    res.json(updateTrackedSubscription(db, idParam.parse(req.params["id"]), body.parse(req.body)));
  });

  router.post("/tracked-subscriptions/:id/status", (req, res) => {
    const input = z
      .object({ status: z.enum(["active", "cancelled"]), on: day.nullable().optional() })
      .strict()
      .parse(req.body);
    res.json(
      setTrackedSubscriptionStatus(
        db,
        idParam.parse(req.params["id"]),
        input.status,
        input.on ?? null,
      ),
    );
  });

  router.delete("/tracked-subscriptions/:id", (req, res) => {
    deleteTrackedSubscription(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  return router;
}
