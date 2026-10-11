import { and, asc, eq } from "drizzle-orm";
import { accounts, balanceSnapshots, collectionItems } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { cardKey, parseCollectionExport, type ParsedExport } from "./collection-import.js";
import { COLLECTION_SUBTYPES, POKEMON_COLLECTION_SUBTYPE } from "./manual-transaction.service.js";

export type CollectionType = "pokemon" | "other";

/** Card conditions, best to worst; Pokemon cards are Lightly Played unless they say otherwise. */
export const CARD_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export const DEFAULT_CARD_CONDITION = "LP";

/**
 * Collection accounts: items kept by hand (trading cards and the like), each with a quantity and
 * what one is worth. The account's balance is the sum of quantity × value (items with no value yet
 * count as nothing), recorded as a balance point whenever it changes, so it shows in net worth and
 * its history.
 */

export interface CollectionItemDto {
  id: number;
  name: string;
  variant: string;
  setCode: string;
  number: string;
  quantity: number;
  unitValueMinor: number | null;
  unitCostMinor: number | null;
  /** quantity × value (0 without a value). */
  totalValueMinor: number;
  condition: string | null;
  notes: string | null;
  /** "manual" when typed in (price updates leave it), "market" when it is the market price. */
  valueSource: string | null;
  /** TCGplayer's product id, once looked up. */
  tcgplayerId: string | null;
  /** The latest market price of one, from the price service, and when it was fetched. */
  marketPriceMinor: number | null;
  priceUpdatedAt: string | null;
  /** "matched", "not_found", or null before any search; and what it matched. */
  priceMatchStatus: string | null;
  priceMatchLabel: string | null;
}

export interface CollectionDto {
  accountId: number;
  name: string;
  /** "pokemon": cards with TCGplayer ids, conditions and market prices; "other": valued by hand. */
  type: CollectionType;
  items: CollectionItemDto[];
  totalValueMinor: number;
  totalQuantity: number;
  /** Items (not copies) with no value entered yet. */
  unvaluedItems: number;
}

export interface ItemInput {
  name: string;
  variant?: string | undefined;
  setCode?: string | undefined;
  number?: string | undefined;
  quantity: number;
  unitValueMinor?: number | null | undefined;
  unitCostMinor?: number | null | undefined;
  condition?: string | null | undefined;
  notes?: string | null | undefined;
  /** Pokemon cards: TCGplayer's product id (the number in the card's tcgplayer.com/product/ link). */
  tcgplayerId?: string | null | undefined;
}

const MAX_MINOR = 100_000_000_00;

function requireCollection(
  db: Pick<AppDb, "select">,
  accountId: number,
): { name: string; currency: string; type: CollectionType } {
  const row = db
    .select({
      name: accounts.name,
      currency: accounts.currency,
      subtype: accounts.subtype,
      isManual: accounts.isManual,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!row) throw notFound("That account");
  if (!row.isManual || !COLLECTION_SUBTYPES.has(row.subtype ?? "")) {
    throw new AppError(409, "not_collection", "That account is not a collection.");
  }
  const type: CollectionType = row.subtype === POKEMON_COLLECTION_SUBTYPE ? "pokemon" : "other";
  return { name: row.name, currency: row.currency, type };
}

/** Pokemon cards need a TCGplayer id and one of the card conditions (LP when left out). */
function checkForType(
  type: CollectionType,
  input: ItemInput,
  { requireId }: { requireId: boolean },
): ItemInput {
  if (type !== "pokemon") return { ...input, tcgplayerId: null };
  const tcgplayerId = input.tcgplayerId?.trim() ?? "";
  // A card being added must have one; an imported card still without one can be edited.
  if ((requireId || tcgplayerId !== "") && !/^\d{1,12}$/.test(tcgplayerId)) {
    throw new AppError(
      400,
      "invalid_tcgplayer_id",
      "Enter the card's TCGplayer id: the number in its tcgplayer.com/product/ link.",
    );
  }
  const condition = (input.condition?.trim() || DEFAULT_CARD_CONDITION).toUpperCase();
  if (!(CARD_CONDITIONS as readonly string[]).includes(condition)) {
    throw new AppError(
      400,
      "invalid_condition",
      "Choose the card's condition: NM, LP, MP, HP or DMG.",
    );
  }
  return { ...input, tcgplayerId: tcgplayerId || null, condition };
}

function check(input: ItemInput): void {
  if (!input.name.trim()) throw new AppError(400, "invalid_name", "Give the item a name.");
  if (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 1_000_000) {
    throw new AppError(400, "invalid_quantity", "Enter how many, as a whole number.");
  }
  for (const v of [input.unitValueMinor, input.unitCostMinor]) {
    if (v != null && (!Number.isInteger(v) || v < 0 || v > MAX_MINOR)) {
      throw new AppError(
        400,
        "invalid_amount",
        "Enter the value as a positive amount, or leave it empty.",
      );
    }
  }
}

const totalOf = (i: { quantity: number; unitValueMinor: number | null }) =>
  i.quantity * (i.unitValueMinor ?? 0);

/** Sets the account's balance to what its items are worth, and records the point if it changed. */
export function recomputeCollectionValue(
  db: Pick<AppDb, "select" | "update" | "insert">,
  accountId: number,
  now: string,
): number {
  const items = db
    .select({ quantity: collectionItems.quantity, unitValueMinor: collectionItems.unitValueMinor })
    .from(collectionItems)
    .where(eq(collectionItems.accountId, accountId))
    .all();
  const value = items.reduce((n, i) => n + totalOf(i), 0);
  const account = db
    .select({ balance: accounts.currentBalanceMinor, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (account && account.balance !== value) {
    db.update(accounts)
      .set({ currentBalanceMinor: value, lastBalanceUpdateAt: now, updatedAt: now })
      .where(eq(accounts.id, accountId))
      .run();
    db.insert(balanceSnapshots)
      .values({
        accountId,
        observedAt: now,
        currentBalanceMinor: value,
        availableBalanceMinor: null,
        currency: account.currency,
      })
      .run();
  }
  return value;
}

export function getCollection(db: AppDb, accountId: number): CollectionDto {
  const account = requireCollection(db, accountId);
  const rows = db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.accountId, accountId))
    .orderBy(asc(collectionItems.setCode), asc(collectionItems.number), asc(collectionItems.name))
    .all();
  const items = rows.map((r): CollectionItemDto => ({
    id: r.id,
    name: r.name,
    variant: r.variant,
    setCode: r.setCode,
    number: r.number,
    quantity: r.quantity,
    unitValueMinor: r.unitValueMinor,
    unitCostMinor: r.unitCostMinor,
    totalValueMinor: totalOf(r),
    condition: r.condition,
    notes: r.notes,
    valueSource: r.valueSource,
    tcgplayerId: r.tcgplayerId,
    marketPriceMinor: r.marketPriceMinor,
    priceUpdatedAt: r.priceUpdatedAt,
    priceMatchStatus: r.priceMatchStatus,
    priceMatchLabel: r.priceMatchLabel,
  }));
  return {
    accountId,
    name: account.name,
    type: account.type,
    items,
    totalValueMinor: items.reduce((n, i) => n + i.totalValueMinor, 0),
    totalQuantity: items.reduce((n, i) => n + i.quantity, 0),
    unvaluedItems: items.filter((i) => i.unitValueMinor === null).length,
  };
}

function valuesOf(input: ItemInput, type: CollectionType) {
  const name = input.name.trim();
  const variant = input.variant?.trim() ?? "";
  const setCode = input.setCode?.trim() ?? "";
  const number = input.number?.trim() ?? "";
  // The same Pokemon card in another condition is a separate item (LP, the usual, keeps the
  // plain key so imports, which are LP, merge with it).
  const condition = input.condition?.trim().toUpperCase() ?? "";
  const conditionKey =
    type === "pokemon" && condition && condition !== DEFAULT_CARD_CONDITION ? `|${condition}` : "";
  return {
    itemKey: cardKey(name, variant, setCode, number) + conditionKey,
    name,
    variant,
    setCode,
    number,
    quantity: input.quantity,
    unitValueMinor: input.unitValueMinor ?? null,
    unitCostMinor: input.unitCostMinor ?? null,
    condition: input.condition?.trim() || null,
    notes: input.notes?.trim() || null,
    tcgplayerId: input.tcgplayerId?.trim() || null,
    valueSource: input.unitValueMinor != null ? "manual" : null,
  };
}

export function addItem(
  db: AppDb,
  accountId: number,
  input: ItemInput,
  now = new Date().toISOString(),
): CollectionDto {
  const { type } = requireCollection(db, accountId);
  const item = checkForType(type, input, { requireId: true });
  check(item);
  const values = valuesOf(item, type);
  db.transaction((tx) => {
    const existing = tx
      .select({ id: collectionItems.id, quantity: collectionItems.quantity })
      .from(collectionItems)
      .where(
        and(eq(collectionItems.accountId, accountId), eq(collectionItems.itemKey, values.itemKey)),
      )
      .get();
    if (existing) {
      // The same item again: one more of it.
      tx.update(collectionItems)
        .set({ quantity: existing.quantity + values.quantity, updatedAt: now })
        .where(eq(collectionItems.id, existing.id))
        .run();
    } else {
      tx.insert(collectionItems)
        .values({ ...values, accountId, createdAt: now, updatedAt: now })
        .run();
    }
    recomputeCollectionValue(tx, accountId, now);
  });
  return getCollection(db, accountId);
}

export function updateItem(
  db: AppDb,
  accountId: number,
  itemId: number,
  input: ItemInput,
  now = new Date().toISOString(),
): CollectionDto {
  const { type } = requireCollection(db, accountId);
  const before = db
    .select()
    .from(collectionItems)
    .where(and(eq(collectionItems.id, itemId), eq(collectionItems.accountId, accountId)))
    .get();
  if (!before) throw notFound("That item");
  // Fields left out of the change keep what they were.
  const item = checkForType(
    type,
    {
      ...input,
      tcgplayerId: input.tcgplayerId === undefined ? before.tcgplayerId : input.tcgplayerId,
      condition: input.condition === undefined ? before.condition : input.condition,
    },
    { requireId: false },
  );
  check(item);
  const values = valuesOf(item, type);
  const clash = db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(
      and(eq(collectionItems.accountId, accountId), eq(collectionItems.itemKey, values.itemKey)),
    )
    .get();
  if (clash && clash.id !== itemId) {
    throw new AppError(
      409,
      "duplicate_item",
      "That item is already in the collection. Change its quantity instead.",
    );
  }
  const valueChanged = before.unitValueMinor !== values.unitValueMinor;
  // A different card, id or condition needs a fresh match on the price service.
  const sameCard =
    before.itemKey === values.itemKey &&
    before.tcgplayerId === values.tcgplayerId &&
    (before.condition ?? DEFAULT_CARD_CONDITION) === (values.condition ?? DEFAULT_CARD_CONDITION);
  db.transaction((tx) => {
    const res = tx
      .update(collectionItems)
      .set({
        ...values,
        // A value typed in is kept from then on; clearing it lets the market price fill it again.
        valueSource: valueChanged ? values.valueSource : before.valueSource,
        ...(sameCard
          ? {}
          : {
              priceMatchStatus: null,
              priceVariantId: null,
              priceMatchLabel: null,
            }),
        updatedAt: now,
      })
      .where(and(eq(collectionItems.id, itemId), eq(collectionItems.accountId, accountId)))
      .run();
    if (res.changes === 0) throw notFound("That item");
    recomputeCollectionValue(tx, accountId, now);
  });
  return getCollection(db, accountId);
}

export function deleteItem(
  db: AppDb,
  accountId: number,
  itemId: number,
  now = new Date().toISOString(),
): CollectionDto {
  requireCollection(db, accountId);
  db.transaction((tx) => {
    const res = tx
      .delete(collectionItems)
      .where(and(eq(collectionItems.id, itemId), eq(collectionItems.accountId, accountId)))
      .run();
    if (res.changes === 0) throw notFound("That item");
    recomputeCollectionValue(tx, accountId, now);
  });
  return getCollection(db, accountId);
}

export interface ImportResult {
  parsed: ParsedExport;
  added: number;
  updated: number;
  collection: CollectionDto | null;
}

/**
 * Imports a TCGPlayer export. `merge` adds new items and, for items already there, sets the
 * quantity to the export's (the export is a full list; values entered by hand are kept).
 * `preview` only parses and reports, changing nothing.
 */
export function importCollection(
  db: AppDb,
  accountId: number,
  text: string,
  options: { preview: boolean },
  now = new Date().toISOString(),
): ImportResult {
  const { type } = requireCollection(db, accountId);
  const parsed = parseCollectionExport(text);
  if (parsed.cards.length === 0) {
    throw new AppError(
      400,
      "nothing_to_import",
      "No cards were found. Paste the lines of a TCGPlayer export.",
    );
  }
  const existing = new Map(
    db
      .select({ id: collectionItems.id, itemKey: collectionItems.itemKey })
      .from(collectionItems)
      .where(eq(collectionItems.accountId, accountId))
      .all()
      .map((r) => [r.itemKey, r.id]),
  );
  const added = parsed.cards.filter((c) => !existing.has(c.key)).length;
  const updated = parsed.cards.length - added;
  if (options.preview) return { parsed, added, updated, collection: null };
  db.transaction((tx) => {
    for (const c of parsed.cards) {
      const id = existing.get(c.key);
      if (id !== undefined) {
        tx.update(collectionItems)
          .set({ quantity: c.quantity, updatedAt: now })
          .where(eq(collectionItems.id, id))
          .run();
      } else {
        tx.insert(collectionItems)
          .values({
            accountId,
            itemKey: c.key,
            name: c.name,
            variant: c.variant,
            setCode: c.setCode,
            number: c.number,
            quantity: c.quantity,
            condition: type === "pokemon" ? DEFAULT_CARD_CONDITION : null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    }
    recomputeCollectionValue(tx, accountId, now);
  });
  return { parsed, added, updated, collection: getCollection(db, accountId) };
}
