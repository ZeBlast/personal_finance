import { Router } from "express";
import { z } from "zod";
import { suggestFolder, type ViewerService } from "../services/viewer.service.js";

const idParam = z.coerce.number().int().positive();
const name = z.string().min(1).max(60);
const folder = z.string().min(1).max(500);

/** Settings > Phone viewer: pair phones, rename or move them, forget them, write now. */
export function viewerRoutes(viewer: ViewerService): Router {
  const router = Router();

  router.get("/viewer/devices", (_req, res) => {
    res.json({ devices: viewer.list(), suggestedFolder: suggestFolder() });
  });

  /** Pairs a phone. The response holds its key, for the QR code, and is the only time it is sent. */
  router.post("/viewer/devices", (req, res) => {
    const body = z.object({ name, folder }).strict().parse(req.body);
    const paired = viewer.pair(body);
    // The first snapshot right away, so the phone has something to open when it scans the code.
    viewer.scheduleWrite(0);
    res.status(201).json(paired);
  });

  router.patch("/viewer/devices/:id", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    const body = z
      .object({ name: name.optional(), folder: folder.optional() })
      .strict()
      .parse(req.body);
    const device = viewer.update(id, body);
    viewer.scheduleWrite(0);
    res.json(device);
  });

  router.delete("/viewer/devices/:id", (req, res) => {
    viewer.revoke(idParam.parse(req.params["id"]));
    res.status(204).end();
  });

  router.post("/viewer/write", async (_req, res) => {
    res.json(await viewer.writeAll());
  });

  return router;
}
