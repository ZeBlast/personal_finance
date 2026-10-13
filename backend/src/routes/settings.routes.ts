import { Router } from "express";
import type { AppDb } from "../db/client.js";
import { syncOwnNameRules } from "../services/default-rules.service.js";
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
    const updated = updateSettings(db, parsed.data);
    // Money to and from the names you go by is filed as moving your own money.
    if (parsed.data.ownNames !== undefined) syncOwnNameRules(db, updated.ownNames);
    res.json(updated);
  });

  return router;
}
