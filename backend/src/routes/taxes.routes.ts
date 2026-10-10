import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { getSettings } from "../services/settings.service.js";
import {
  clearTaxProfile,
  getTaxProfile,
  saveTaxProfile,
  taxIncome,
  taxProfileSchema,
} from "../services/taxes.service.js";

const year = z.coerce.number().int().min(2000).max(2100);

export function taxesRoutes(db: AppDb): Router {
  const router = Router();

  // The year's income and credit transactions, and the answers saved for that year.
  router.get("/taxes/:year", (req, res) => {
    const y = year.parse(req.params["year"]);
    res.json({
      ...taxIncome(db, y, getSettings(db).plaidEnvironment),
      profile: getTaxProfile(db, y),
    });
  });

  router.put("/taxes/:year/profile", (req, res) => {
    const y = year.parse(req.params["year"]);
    res.json(saveTaxProfile(db, y, taxProfileSchema.parse(req.body)));
  });

  router.delete("/taxes/:year/profile", (req, res) => {
    clearTaxProfile(db, year.parse(req.params["year"]));
    res.status(204).end();
  });

  return router;
}
