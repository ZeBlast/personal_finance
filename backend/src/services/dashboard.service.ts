import { and, asc, count, eq, notInArray, sql } from "drizzle-orm";
import { dashboards, dashboardWidgets } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { getSettings, updateSettings } from "./settings.service.js";

/**
 * Stores named dashboards: which widgets are on each, where, and with what settings.
 *
 * The server deliberately does not know what widget types exist. A widget's type is just the ID it
 * registered under in the frontend, and its settings are an opaque JSON object. So adding, renaming
 * or removing a widget in the app never needs a server change or a database migration, and a layout
 * that mentions a widget this version no longer has is simply kept as it is.
 *
 * There is always at least one dashboard. The one shown is the "active" dashboard (a setting).
 */

export const MAX_WIDGETS = 100;
export const MAX_CONFIG_CHARS = 20_000;
export const MAX_DASHBOARDS = 12;
const TYPE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export interface WidgetInstance {
  /** Absent for a widget that has not been saved yet. */
  id?: number | undefined;
  widgetType: string;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}

export interface SavedWidget extends WidgetInstance {
  id: number;
}

export interface DashboardLayout {
  dashboardId: number;
  /** False until the first save: the frontend then builds the default layout from its registry. */
  initialized: boolean;
  widgets: SavedWidget[];
}

export interface DashboardSummary {
  id: number;
  name: string;
  widgetCount: number;
}

function parseConfig(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {}; // a damaged value must never break the dashboard
  }
}

function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 1 || trimmed.length > 40) {
    throw new AppError(400, "invalid_name", "A dashboard name needs 1 to 40 characters.");
  }
  return trimmed;
}

function requireDashboard(db: Pick<AppDb, "select">, id: number) {
  const row = db.select().from(dashboards).where(eq(dashboards.id, id)).get();
  if (!row) throw notFound("That dashboard");
  return row;
}

/** Makes sure at least one dashboard exists (a database made before dashboards had names). */
function ensureOne(db: AppDb): void {
  const n = db.select({ n: count() }).from(dashboards).get()?.n ?? 0;
  if (n > 0) return;
  const now = new Date().toISOString();
  db.insert(dashboards)
    .values({ id: 1, name: "Main", initialized: false, createdAt: now, updatedAt: now })
    .run();
}

/** The dashboard being shown: the saved choice if it still exists, else the first one. */
export function activeDashboardId(db: AppDb): number {
  ensureOne(db);
  const chosen = getSettings(db).activeDashboardId;
  if (db.select({ id: dashboards.id }).from(dashboards).where(eq(dashboards.id, chosen)).get()) {
    return chosen;
  }
  return db.select({ id: dashboards.id }).from(dashboards).orderBy(asc(dashboards.id)).get()!.id;
}

export function listDashboards(db: AppDb): { active: number; dashboards: DashboardSummary[] } {
  const active = activeDashboardId(db);
  const rows = db
    .select({
      id: dashboards.id,
      name: dashboards.name,
      widgetCount: sql<number>`(select count(*) from dashboard_widgets w where w.dashboard_id = dashboards.id)`,
    })
    .from(dashboards)
    .orderBy(asc(dashboards.id))
    .all();
  return { active, dashboards: rows };
}

export function setActiveDashboard(db: AppDb, id: number): void {
  requireDashboard(db, id);
  updateSettings(db, { activeDashboardId: id });
}

export function createDashboard(
  db: AppDb,
  input: { name: string; copyFrom?: number | undefined },
): DashboardSummary {
  ensureOne(db);
  const name = normalizeName(input.name);
  const existing = db.select().from(dashboards).all();
  if (existing.length >= MAX_DASHBOARDS) {
    throw new AppError(409, "too_many_dashboards", `At most ${MAX_DASHBOARDS} dashboards.`);
  }
  if (existing.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError(409, "name_taken", "You already have a dashboard with that name.");
  }
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const source = input.copyFrom === undefined ? null : requireDashboard(tx, input.copyFrom);
    const created = tx
      .insert(dashboards)
      .values({ name, initialized: source?.initialized ?? false, createdAt: now, updatedAt: now })
      .returning({ id: dashboards.id })
      .get();
    let widgetCount = 0;
    if (source) {
      const widgets = tx
        .select()
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.dashboardId, source.id))
        .all();
      for (const w of widgets) {
        tx.insert(dashboardWidgets)
          .values({
            dashboardId: created.id,
            widgetType: w.widgetType,
            enabled: w.enabled,
            x: w.x,
            y: w.y,
            w: w.w,
            h: w.h,
            config: w.config,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      widgetCount = widgets.length;
    }
    return { id: created.id, name, widgetCount };
  });
}

export function renameDashboard(db: AppDb, id: number, rawName: string): void {
  requireDashboard(db, id);
  const name = normalizeName(rawName);
  const clash = db
    .select()
    .from(dashboards)
    .all()
    .some((d) => d.id !== id && d.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new AppError(409, "name_taken", "You already have a dashboard with that name.");
  db.update(dashboards)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(dashboards.id, id))
    .run();
}

/** Deletes a dashboard and its widgets. The last one cannot be deleted. */
export function deleteDashboard(db: AppDb, id: number): void {
  requireDashboard(db, id);
  const total = db.select({ n: count() }).from(dashboards).get()?.n ?? 0;
  if (total <= 1) {
    throw new AppError(409, "last_dashboard", "You need at least one dashboard.");
  }
  db.transaction((tx) => {
    tx.delete(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, id)).run();
    tx.delete(dashboards).where(eq(dashboards.id, id)).run();
  });
}

export function getLayout(db: AppDb, dashboardId?: number): DashboardLayout {
  const id = dashboardId ?? activeDashboardId(db);
  const dashboard = requireDashboard(db, id);
  const rows = db
    .select()
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, id))
    .orderBy(asc(dashboardWidgets.y), asc(dashboardWidgets.x), asc(dashboardWidgets.id))
    .all();
  return {
    dashboardId: id,
    initialized: dashboard.initialized,
    widgets: rows.map((row) => ({
      id: row.id,
      widgetType: row.widgetType,
      enabled: row.enabled,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      config: parseConfig(row.config),
    })),
  };
}

/** Checks one widget's shape and size without caring what kind of widget it is. */
function validate(widget: WidgetInstance): string {
  if (!TYPE_PATTERN.test(widget.widgetType)) {
    throw new AppError(
      400,
      "invalid_widget",
      "A widget type may use letters, numbers, dots, dashes and underscores.",
    );
  }
  const config = JSON.stringify(widget.config);
  if (config.length > MAX_CONFIG_CHARS) {
    throw new AppError(400, "config_too_large", "A widget's settings are too large.");
  }
  return config;
}

/**
 * Saves one dashboard's whole layout in one transaction: widgets with a known ID (on THIS
 * dashboard) are updated, others are added, and anything not mentioned is removed. Saving also
 * marks the dashboard as set up, even when empty, so one the user cleared is not refilled.
 */
export function saveLayout(
  db: AppDb,
  dashboardId: number,
  widgets: WidgetInstance[],
): DashboardLayout {
  requireDashboard(db, dashboardId);
  if (widgets.length > MAX_WIDGETS) {
    throw new AppError(
      400,
      "too_many_widgets",
      `A dashboard can hold at most ${MAX_WIDGETS} widgets.`,
    );
  }
  const prepared = widgets.map((widget) => ({ widget, config: validate(widget) }));
  const now = new Date().toISOString();

  db.transaction((tx) => {
    const existing = new Set(
      tx
        .select({ id: dashboardWidgets.id })
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.dashboardId, dashboardId))
        .all()
        .map((r) => r.id),
    );
    const keep: number[] = [];
    for (const { widget, config } of prepared) {
      const fields = {
        widgetType: widget.widgetType,
        enabled: widget.enabled,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        config,
        updatedAt: now,
      };
      if (widget.id !== undefined && existing.has(widget.id) && !keep.includes(widget.id)) {
        tx.update(dashboardWidgets).set(fields).where(eq(dashboardWidgets.id, widget.id)).run();
        keep.push(widget.id);
      } else {
        const created = tx
          .insert(dashboardWidgets)
          .values({ ...fields, dashboardId, createdAt: now })
          .returning({ id: dashboardWidgets.id })
          .get();
        keep.push(created.id);
      }
    }
    const here = eq(dashboardWidgets.dashboardId, dashboardId);
    if (keep.length === 0) tx.delete(dashboardWidgets).where(here).run();
    else
      tx.delete(dashboardWidgets)
        .where(and(here, notInArray(dashboardWidgets.id, keep)))
        .run();
    tx.update(dashboards)
      .set({ initialized: true, updatedAt: now })
      .where(eq(dashboards.id, dashboardId))
      .run();
  });
  return getLayout(db, dashboardId);
}

/** Forgets one dashboard's layout; the next load builds the default again. */
export function resetLayout(db: AppDb, dashboardId: number): void {
  requireDashboard(db, dashboardId);
  db.transaction((tx) => {
    tx.delete(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, dashboardId)).run();
    tx.update(dashboards)
      .set({ initialized: false, updatedAt: new Date().toISOString() })
      .where(eq(dashboards.id, dashboardId))
      .run();
  });
}
