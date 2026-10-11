import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { collectionItems, collectionPriceHistory } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { cardKey } from "./collection-import.js";
import {
  DEFAULT_CARD_CONDITION,
  getCollection,
  recomputeCollectionValue,
  type CollectionDto,
} from "./collection.service.js";
import { createManualBankAccount } from "./manual-transaction.service.js";

/**
 * A collection as a file, to move it to another copy of the app without looking anything up
 * again: its items with their TCGplayer ids, conditions, values, market prices, and price
 * history. Never the price service's API key, which stays where it was entered.
 */

export const COLLECTION_FILE_FORMAT = "personal-finance-collection";

const item = z.object({
  name: z.string().trim().min(1).max(200),
  variant: z.string().max(200).default(""),
  setCode: z.string().max(40).default(""),
  number: z.string().max(40).default(""),
  quantity: z.number().int().min(0).max(1_000_000),
  unitValueMinor: z.number().int().min(0).nullable().default(null),
  unitCostMinor: z.number().int().min(0).nullable().default(null),
  condition: z.string().max(40).nullable().default(null),
  notes: z.string().max(1000).nullable().default(null),
  valueSource: z.enum(["manual", "market"]).nullable().default(null),
  tcgplayerId: z.string().max(20).nullable().default(null),
  priceVariantId: z.string().max(200).nullable().default(null),
  priceMatchLabel: z.string().max(500).nullable().default(null),
  priceMatchStatus: z.enum(["matched", "not_found"]).nullable().default(null),
  marketPriceMinor: z.number().int().min(0).nullable().default(null),
  priceUpdatedAt: z.string().max(40).nullable().default(null),
  history: z
    .array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        priceMinor: z.number().int().min(0),
      }),
    )
    .max(5000)
    .default([]),
});

export const collectionFileSchema = z.object({
  format: z.literal(COLLECTION_FILE_FORMAT),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  type: z.enum(["pokemon", "other"]),
  exportedAt: z.string().optional(),
  items: z.array(item).max(50_000),
});
export type CollectionFile = z.infer<typeof collectionFileSchema>;

export function exportCollection(db: AppDb, accountId: number): CollectionFile {
  const collection = getCollection(db, accountId);
  const rows = db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.accountId, accountId))
    .orderBy(asc(collectionItems.setCode), asc(collectionItems.number), asc(collectionItems.name))
    .all();
  const ids = rows.map((r) => r.id);
  const history = new Map<number, Array<{ day: string; priceMinor: number }>>();
  if (ids.length > 0) {
    for (const h of db
      .select()
      .from(collectionPriceHistory)
      .where(inArray(collectionPriceHistory.itemId, ids))
      .orderBy(asc(collectionPriceHistory.day))
      .all()) {
      const list = history.get(h.itemId) ?? [];
      list.push({ day: h.day, priceMinor: h.priceMinor });
      history.set(h.itemId, list);
    }
  }
  return {
    format: COLLECTION_FILE_FORMAT,
    version: 1,
    name: collection.name,
    type: collection.type,
    exportedAt: new Date().toISOString(),
    items: rows.map((r) => ({
      name: r.name,
      variant: r.variant,
      setCode: r.setCode,
      number: r.number,
      quantity: r.quantity,
      unitValueMinor: r.unitValueMinor,
      unitCostMinor: r.unitCostMinor,
      condition: r.condition,
      notes: r.notes,
      valueSource: (r.valueSource as "manual" | "market" | null) ?? null,
      tcgplayerId: r.tcgplayerId,
      priceVariantId: r.priceVariantId,
      priceMatchLabel: r.priceMatchLabel,
      priceMatchStatus: (r.priceMatchStatus as "matched" | "not_found" | null) ?? null,
      marketPriceMinor: r.marketPriceMinor,
      priceUpdatedAt: r.priceUpdatedAt,
      history: history.get(r.id) ?? [],
    })),
  };
}

/** Makes a new collection account from a file, items, prices, and history included. */
export function importCollectionFile(
  db: AppDb,
  file: CollectionFile,
  now = new Date().toISOString(),
): CollectionDto {
  let accountId = 0;
  db.transaction((tx) => {
    accountId = createManualBankAccount(
      tx as unknown as AppDb,
      { name: file.name, kind: file.type === "pokemon" ? "pokemon_cards" : "collection" },
      now,
    );
    const seen = new Set<string>();
    for (const i of file.items) {
      const condition = i.condition?.trim().toUpperCase() || null;
      // The same key rule as items added by hand (a Pokemon card's condition other than LP).
      const key =
        cardKey(i.name, i.variant, i.setCode, i.number) +
        (file.type === "pokemon" && condition && condition !== DEFAULT_CARD_CONDITION
          ? `|${condition}`
          : "");
      if (seen.has(key)) continue;
      seen.add(key);
      const row = tx
        .insert(collectionItems)
        .values({
          accountId,
          itemKey: key,
          name: i.name,
          variant: i.variant,
          setCode: i.setCode,
          number: i.number,
          quantity: i.quantity,
          unitValueMinor: i.unitValueMinor,
          unitCostMinor: i.unitCostMinor,
          condition: file.type === "pokemon" ? (condition ?? DEFAULT_CARD_CONDITION) : i.condition,
          notes: i.notes,
          valueSource: i.valueSource,
          tcgplayerId: i.tcgplayerId,
          priceVariantId: i.priceVariantId,
          priceMatchLabel: i.priceMatchLabel,
          priceMatchStatus: i.priceMatchStatus,
          marketPriceMinor: i.marketPriceMinor,
          priceUpdatedAt: i.priceUpdatedAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: collectionItems.id })
        .get();
      for (const h of i.history) {
        tx.insert(collectionPriceHistory)
          .values({ itemId: row.id, day: h.day, priceMinor: h.priceMinor })
          .onConflictDoNothing()
          .run();
      }
    }
    recomputeCollectionValue(tx, accountId, now);
  });
  return getCollection(db, accountId);
}
