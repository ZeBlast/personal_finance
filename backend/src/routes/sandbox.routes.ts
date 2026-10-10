import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { appSettings, sandboxSaves } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";

/**
 * The sandbox page's graph (nodes and wires), saved as it is. The page does all the maths; the
 * server only keeps the drawing so it is there next time.
 */

const KEY = "sandbox_graph";

const param = z.union([z.string().max(200), z.number(), z.boolean()]);
const graphBody = z
  .object({
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            kind: z.string().min(1).max(40),
            x: z.number(),
            y: z.number(),
            title: z.string().max(80).optional(),
            params: z.record(z.string().max(40), param),
          })
          .strict(),
      )
      .max(300),
    wires: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            from: z.object({ node: z.string().max(64), port: z.string().max(40) }).strict(),
            to: z.object({ node: z.string().max(64), port: z.string().max(40) }).strict(),
          })
          .strict(),
      )
      .max(1000),
    view: z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.1).max(4) }).optional(),
  })
  .strict();

export function sandboxRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/sandbox", (_req, res) => {
    const row = db.select().from(appSettings).where(eq(appSettings.key, KEY)).get();
    res.json(row ? JSON.parse(row.value) : null);
  });

  router.put("/sandbox", (req, res) => {
    const graph = graphBody.parse(req.body);
    const value = JSON.stringify(graph);
    const now = new Date().toISOString();
    db.insert(appSettings)
      .values({ key: KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
      .run();
    res.status(204).end();
  });

  // The experimental cash-flow map: buckets and connections, saved as they are.
  const FLOW_KEY = "sandbox_flow";
  const flowBody = z
    .object({
      nodes: z.array(z.record(z.string().max(40), z.unknown())).max(300),
      links: z.array(z.record(z.string().max(40), z.unknown())).max(1000),
      view: z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.1).max(4) }).optional(),
      settings: z.record(z.string().max(40), z.unknown()).optional(),
    })
    .strict();

  router.get("/sandbox/flow", (_req, res) => {
    const row = db.select().from(appSettings).where(eq(appSettings.key, FLOW_KEY)).get();
    res.json(row ? JSON.parse(row.value) : null);
  });

  router.put("/sandbox/flow", (req, res) => {
    const value = JSON.stringify(flowBody.parse(req.body));
    if (value.length > 500_000) {
      res.status(413).json({ error: "too_large", message: "That map is too large to save." });
      return;
    }
    const now = new Date().toISOString();
    db.insert(appSettings)
      .values({ key: FLOW_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
      .run();
    res.status(204).end();
  });

  // ---- Saved maps: named copies of either drawing, to load again later ------------------------

  const kind = z.enum(["math", "flow"]);
  const saveName = z.string().trim().min(1).max(80);
  const saveData = z.record(z.string().max(40), z.unknown());
  const MAX_SAVES = 200;
  const MAX_SAVE_BYTES = 500_000;
  const id = z.coerce.number().int().positive();

  const tooLarge = (data: unknown): boolean => JSON.stringify(data).length > MAX_SAVE_BYTES;
  const summary = (row: typeof sandboxSaves.$inferSelect) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  /** The saved maps of one kind, most recently changed first (without their contents). */
  router.get("/sandbox/saves", (req, res) => {
    const k = kind.parse(req.query["kind"]);
    res.json(
      db
        .select()
        .from(sandboxSaves)
        .where(eq(sandboxSaves.kind, k))
        .orderBy(desc(sandboxSaves.updatedAt))
        .all()
        .map(summary),
    );
  });

  router.get("/sandbox/saves/:id", (req, res) => {
    const row = db
      .select()
      .from(sandboxSaves)
      .where(eq(sandboxSaves.id, id.parse(req.params["id"])))
      .get();
    if (!row) {
      res.status(404).json({ error: "not_found", message: "That saved map is gone." });
      return;
    }
    res.json({ ...summary(row), data: JSON.parse(row.data) });
  });

  router.post("/sandbox/saves", (req, res) => {
    const body = z.object({ kind, name: saveName, data: saveData }).strict().parse(req.body);
    if (tooLarge(body.data)) {
      res.status(413).json({ error: "too_large", message: "That map is too large to save." });
      return;
    }
    const count = db
      .select()
      .from(sandboxSaves)
      .where(eq(sandboxSaves.kind, body.kind))
      .all().length;
    if (count >= MAX_SAVES) {
      res.status(409).json({ error: "too_many", message: "Delete some saved maps first." });
      return;
    }
    const now = new Date().toISOString();
    const row = db
      .insert(sandboxSaves)
      .values({
        kind: body.kind,
        name: body.name,
        data: JSON.stringify(body.data),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    res.status(201).json(summary(row));
  });

  /** Renames a saved map, or saves over it with new contents. */
  router.put("/sandbox/saves/:id", (req, res) => {
    const body = z
      .object({ name: saveName.optional(), data: saveData.optional() })
      .strict()
      .refine((b) => b.name !== undefined || b.data !== undefined, {
        message: "Nothing to change.",
      })
      .parse(req.body);
    if (body.data && tooLarge(body.data)) {
      res.status(413).json({ error: "too_large", message: "That map is too large to save." });
      return;
    }
    const target = id.parse(req.params["id"]);
    const row = db
      .update(sandboxSaves)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.data !== undefined ? { data: JSON.stringify(body.data) } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(sandboxSaves.id, target))
      .returning()
      .get();
    if (!row) {
      res.status(404).json({ error: "not_found", message: "That saved map is gone." });
      return;
    }
    res.json(summary(row));
  });

  router.delete("/sandbox/saves/:id", (req, res) => {
    db.delete(sandboxSaves)
      .where(and(eq(sandboxSaves.id, id.parse(req.params["id"]))))
      .run();
    res.status(204).end();
  });

  return router;
}
