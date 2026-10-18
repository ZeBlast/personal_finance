import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  INCOME_TREATMENTS,
} from "../services/category.service.js";
import {
  applyRules,
  createRule,
  deleteRule,
  listRules,
  previewRule,
  reorderRules,
  RULE_DIRECTIONS,
  RULE_FIELDS,
  RULE_OPERATORS,
  updateRule,
} from "../services/rule.service.js";

const idParam = z.coerce.number().int().positive();

const createBody = z
  .object({
    name: z.string().max(200),
    parentId: z.number().int().positive().nullable().optional(),
    color: z.string().max(20).nullable().optional(),
    incomeTreatment: z.enum(INCOME_TREATMENTS).nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().max(200).optional(),
    parentId: z.number().int().positive().nullable().optional(),
    color: z.string().max(20).nullable().optional(),
    active: z.boolean().optional(),
    incomeTreatment: z.enum(INCOME_TREATMENTS).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." });

const ruleFields = {
  name: z.string().trim().min(1).max(80),
  field: z.enum(RULE_FIELDS),
  operator: z.enum(RULE_OPERATORS),
  matchValue: z.string().trim().min(1).max(200),
  direction: z.enum(RULE_DIRECTIONS).nullable().optional(),
  categoryId: z.number().int().positive(),
  enabled: z.boolean().optional(),
};
const ruleCreateBody = z.object(ruleFields).strict();
const rulePatchBody = z
  .object(ruleFields)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." });
const rulePreviewBody = z
  .object({
    field: ruleFields.field,
    operator: ruleFields.operator,
    matchValue: ruleFields.matchValue,
    direction: ruleFields.direction,
    // With these, the preview also says what saving the rule would really change.
    categoryId: ruleFields.categoryId.optional(),
    ruleId: z.number().int().positive().optional(),
  })
  .strict();

export function categoriesRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/categories", (req, res) => {
    res.json(listCategories(db, req.query["includeInactive"] === "1"));
  });

  router.post("/categories", (req, res) => {
    res.status(201).json(createCategory(db, createBody.parse(req.body)));
  });

  router.patch("/categories/:id", (req, res) => {
    res.json(updateCategory(db, idParam.parse(req.params["id"]), patchBody.parse(req.body)));
  });

  /** Deletes an unused category, archives one in use, or moves everything to `?reassignTo=ID` first. */
  router.delete("/categories/:id", (req, res) => {
    const reassign =
      req.query["reassignTo"] === undefined ? undefined : idParam.parse(req.query["reassignTo"]);
    res.json(deleteCategory(db, idParam.parse(req.params["id"]), reassign));
  });

  // ---- Rules ----

  router.get("/rules", (_req, res) => {
    res.json(listRules(db));
  });

  router.post("/rules", (req, res) => {
    res.status(201).json(createRule(db, ruleCreateBody.parse(req.body)));
  });

  // Fixed paths must come before /rules/:id so "apply" and "reorder" are not read as IDs.
  router.post("/rules/apply", (_req, res) => {
    res.json(applyRules(db));
  });

  router.post("/rules/reorder", (req, res) => {
    const body = z
      .object({ orderedIds: z.array(z.number().int().positive()).max(1000) })
      .strict()
      .parse(req.body);
    res.json(reorderRules(db, body.orderedIds));
  });

  router.post("/rules/preview", (req, res) => {
    res.json(previewRule(db, rulePreviewBody.parse(req.body)));
  });

  router.patch("/rules/:id", (req, res) => {
    res.json(updateRule(db, idParam.parse(req.params["id"]), rulePatchBody.parse(req.body)));
  });

  router.delete("/rules/:id", (req, res) => {
    deleteRule(db, idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  return router;
}
