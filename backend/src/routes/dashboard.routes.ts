import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  activeDashboardId,
  createDashboard,
  deleteDashboard,
  getLayout,
  listDashboards,
  renameDashboard,
  resetLayout,
  saveLayout,
  setActiveDashboard,
} from "../services/dashboard.service.js";

/**
 * Only the shape of a widget is checked here (position, size, a safe type name, a settings object).
 * What a widget type means is the frontend's business, which is what keeps new widgets from needing
 * any server change.
 */
const widgetBody = z
  .object({
    id: z.number().int().positive().optional(),
    widgetType: z.string().min(1).max(64),
    enabled: z.boolean(),
    x: z.number().int().min(0).max(1000),
    y: z.number().int().min(0).max(100_000),
    w: z.number().int().min(1).max(48),
    h: z.number().int().min(1).max(200),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const saveBody = z.object({ widgets: z.array(widgetBody).max(100) }).strict();

const idParam = z.coerce.number().int().positive();
const nameBody = z.object({ name: z.string().max(200) }).strict();
const createBody = z
  .object({ name: z.string().max(200), copyFrom: z.number().int().positive().optional() })
  .strict();
/** Layout calls act on the active dashboard unless a dashboard is named. */
const layoutQuery = z.object({ dashboardId: idParam.optional() });

export function dashboardRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/dashboards", (_req, res) => {
    res.json(listDashboards(db));
  });

  router.post("/dashboards", (req, res) => {
    res.status(201).json(createDashboard(db, createBody.parse(req.body)));
  });

  router.patch("/dashboards/:id", (req, res) => {
    renameDashboard(db, idParam.parse(req.params["id"]), nameBody.parse(req.body).name);
    res.json(listDashboards(db));
  });

  router.delete("/dashboards/:id", (req, res) => {
    deleteDashboard(db, idParam.parse(req.params["id"]));
    res.json(listDashboards(db));
  });

  router.post("/dashboards/:id/activate", (req, res) => {
    setActiveDashboard(db, idParam.parse(req.params["id"]));
    res.json(listDashboards(db));
  });

  router.get("/dashboard/widgets", (req, res) => {
    res.json(getLayout(db, layoutQuery.parse(req.query).dashboardId));
  });

  /** Replaces the whole layout (what the dashboard's Done button sends). */
  router.put("/dashboard/widgets", (req, res) => {
    const id = layoutQuery.parse(req.query).dashboardId ?? activeDashboardId(db);
    res.json(saveLayout(db, id, saveBody.parse(req.body).widgets));
  });

  /** Forgets the layout so the next load builds the default again. */
  router.post("/dashboard/reset", (req, res) => {
    const id = layoutQuery.parse(req.query).dashboardId ?? activeDashboardId(db);
    resetLayout(db, id);
    res.json(getLayout(db, id));
  });

  return router;
}
