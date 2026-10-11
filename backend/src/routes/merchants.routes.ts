import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { assignMerchant, listMerchants } from "../services/merchant.service.js";
import {
  createMerchantGroup,
  deleteMerchantGroup,
  listMerchantGroups,
  renameMerchantGroup,
  setMerchantGroup,
  updateMerchantGroup,
} from "../services/merchant-group.service.js";

const groupBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    merchants: z.array(z.string().min(1).max(200)).min(1).max(500),
  })
  .strict();
const groupId = z.coerce.number().int().positive();

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

  /** Merchants grouped as one (several names for one place). */
  router.get("/merchant-groups", (_req, res) => {
    res.json(listMerchantGroups(db));
  });
  router.post("/merchant-groups", (req, res) => {
    res.status(201).json(createMerchantGroup(db, groupBody.parse(req.body)));
  });
  /** One merchant into a group (existing, or new by name), or out of its group. */
  router.put("/merchant-groups/membership", (req, res) => {
    const body = z
      .object({
        merchant: z.string().min(1).max(200),
        groupId: z.number().int().positive().nullable().optional(),
        newGroup: z.string().trim().min(1).max(100).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(setMerchantGroup(db, body));
  });
  router.patch("/merchant-groups/:id", (req, res) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .parse(req.body);
    res.json(renameMerchantGroup(db, groupId.parse(req.params["id"]), body.name));
  });
  router.put("/merchant-groups/:id", (req, res) => {
    res.json(updateMerchantGroup(db, groupId.parse(req.params["id"]), groupBody.parse(req.body)));
  });
  router.delete("/merchant-groups/:id", (req, res) => {
    deleteMerchantGroup(db, groupId.parse(req.params["id"]));
    res.status(204).end();
  });

  router.get("/merchants", (req, res) => {
    res.json(listMerchants(db, listQuery.parse(req.query)));
  });

  /** Assign a merchant to a category (or, with a null category, remove the assignment). */
  router.put("/merchants/assignment", (req, res) => {
    res.json(assignMerchant(db, assignBody.parse(req.body)));
  });

  return router;
}
