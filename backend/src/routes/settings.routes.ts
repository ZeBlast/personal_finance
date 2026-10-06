import { Router } from "express";
import type { AppDb } from "../db/client.js";
import { getSettings, settingsPatchSchema, updateSettings } from "../services/settings.service.js";

export function settingsRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/settings", (_req, res) => {
    res.json(getSettings(db));
  });

  router.patch("/settings", (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_settings",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    res.json(updateSettings(db, parsed.data));
  });

  return router;
}
