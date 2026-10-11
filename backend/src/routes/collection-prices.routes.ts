import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import {
  clearCardPriceKey,
  clearCollectionPrices,
  hasCardPriceKey,
  itemPriceHistory,
  priceRunCost,
  priceRunStatus,
  resetItemMatch,
  saveCardPriceKey,
  startPriceUpdate,
  type ClientOptions,
} from "../services/card-price.service.js";
import { getCollection } from "../services/collection.service.js";
import type { TokenCipher } from "../services/crypto.js";
import { AppError } from "../utils/errors.js";
import { findTcgplayerIds } from "../services/tcgplayer-ids.service.js";

const idParam = z.coerce.number().int().positive();

/** Card prices from JustTCG: the API key, price runs, and an item's price history. */
export function collectionPricesRoutes(
  db: AppDb,
  cipher: TokenCipher,
  client: ClientOptions = {},
): Router {
  const router = Router();

  /** Market prices are for Pokemon card collections only. */
  const requirePokemon = (id: number): void => {
    if (getCollection(db, id).type !== "pokemon") {
      throw new AppError(
        409,
        "not_pokemon",
        "Market prices are only for Pokémon card collections.",
      );
    }
  };

  // The key is stored encrypted and never sent back; only whether one is saved.
  router.get("/card-prices/key", (_req, res) => {
    res.json({ saved: hasCardPriceKey(db) });
  });
  router.put("/card-prices/key", (req, res) => {
    const body = z
      .object({ apiKey: z.string().trim().min(8).max(200) })
      .strict()
      .parse(req.body);
    saveCardPriceKey(db, cipher, body.apiKey);
    res.json({ saved: true });
  });
  router.delete("/card-prices/key", (_req, res) => {
    clearCardPriceKey(db);
    res.json({ saved: false });
  });

  /** Starts matching and pricing in the background. `limit: 20` is the one-batch test run. */
  router.post("/accounts/:id/collection/prices/update", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    requirePokemon(id);
    const body = z
      .object({ limit: z.number().int().min(1).max(10_000).optional() })
      .strict()
      .parse(req.body ?? {});
    res.status(202).json(startPriceUpdate(db, cipher, id, { limit: body.limit, client }));
  });
  /** What a run would spend, and what is left today and this month. */
  router.get("/accounts/:id/collection/prices/cost", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    requirePokemon(id);
    const limit = req.query["limit"] ? idParam.parse(req.query["limit"]) : undefined;
    res.json(priceRunCost(db, id, limit));
  });
  router.get("/accounts/:id/collection/prices/status", (req, res) => {
    res.json(priceRunStatus(idParam.parse(req.params["id"])));
  });

  router.get("/accounts/:id/collection/items/:itemId/prices", (req, res) => {
    res.json(
      itemPriceHistory(db, idParam.parse(req.params["id"]), idParam.parse(req.params["itemId"])),
    );
  });
  /** Looks up TCGplayer ids (free: tcgcsv.com, no JustTCG requests) for items without one. */
  router.post("/accounts/:id/collection/tcgplayer-ids", async (req, res) => {
    const id = idParam.parse(req.params["id"]);
    requirePokemon(id);
    res.json(await findTcgplayerIds(db, id, client.fetchImpl));
  });

  /** Undoes price lookups (keeps TCGplayer ids and values typed in). */
  router.post("/accounts/:id/collection/prices/clear", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    requirePokemon(id);
    res.json(clearCollectionPrices(db, id));
  });

  /** Forgets an item's match, so the next run searches for it again. */
  router.post("/accounts/:id/collection/items/:itemId/rematch", (req, res) => {
    const id = idParam.parse(req.params["id"]);
    resetItemMatch(db, id, idParam.parse(req.params["itemId"]));
    res.json(getCollection(db, id));
  });

  return router;
}
