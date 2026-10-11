import { and, eq, isNull } from "drizzle-orm";
import { collectionItems } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import { sameNumber, type Fetch } from "./card-price.service.js";

/**
 * TCGplayer product ids for collection items, from tcgcsv.com: a free daily copy of TCGplayer's
 * catalog (sets with their codes, and each set's products with their numbers). It needs no key
 * and uses none of the JustTCG allowance. With the ids, prices are fetched 20 cards per request.
 *
 * An item is matched by its set code (the "[MEW]" in an export) and number; when a number has
 * several products (a Poke Ball or Master Ball version), the name and variant choose.
 */

const BASE = "https://tcgcsv.com/tcgplayer";
/** TCGplayer categories: Pokemon (English), then Pokemon Japan. */
const CATEGORIES = [3, 85];
const HEADERS = { "User-Agent": "personal-finance-app (collection prices)" };

interface Group {
  groupId: number;
  name: string;
  abbreviation: string | null;
}
export interface Product {
  productId: number;
  name: string;
  extendedData?: Array<{ name: string; value: string }>;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Picks the product for an item among a set's products, or null. */
export function pickProduct(
  products: Product[],
  item: { name: string; variant: string; number: string },
): Product | null {
  const hits = products.filter((p) => {
    const n = p.extendedData?.find((e) => e.name === "Number")?.value;
    return !!n && sameNumber(n, item.number);
  });
  if (hits.length <= 1) return hits[0] ?? null;
  const full = words(`${item.name} ${item.variant}`);
  const exact = hits.find((p) => words(p.name) === full);
  if (exact) return exact;
  // The regular version has no "(... Pattern)" in its name.
  const want = new Set(full.split(" "));
  const score = (p: Product) => {
    const w = words(p.name).split(" ");
    return w.filter((x) => want.has(x)).length * 2 - w.filter((x) => !want.has(x)).length;
  };
  return [...hits].sort((a, b) => score(b) - score(a))[0]!;
}

export interface IdLookupResult {
  found: number;
  notFound: Array<{ name: string; setCode: string; number: string }>;
  /** Items that already had an id. */
  alreadyKnown: number;
}

/** Looks up TCGplayer ids for a collection's items that have none yet. */
export async function findTcgplayerIds(
  db: AppDb,
  accountId: number,
  fetchImpl: Fetch = fetch,
): Promise<IdLookupResult> {
  const get = async <T>(path: string): Promise<T[]> => {
    let res: Response;
    try {
      res = await fetchImpl(`${BASE}${path}`, { headers: HEADERS });
    } catch {
      throw new AppError(
        502,
        "tcgcsv_unreachable",
        "Couldn't reach tcgcsv.com to look up TCGplayer ids.",
      );
    }
    if (!res.ok) throw new AppError(502, "tcgcsv_error", `tcgcsv.com answered ${res.status}.`);
    return ((await res.json()) as { results?: T[] }).results ?? [];
  };

  const all = db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.accountId, accountId))
    .all();
  const todo = all.filter((i) => !i.tcgplayerId && i.setCode && i.number);
  const result: IdLookupResult = { found: 0, notFound: [], alreadyKnown: all.length - todo.length };
  if (todo.length === 0) return result;

  const groups = new Map<number, Group[]>();
  for (const category of CATEGORIES) groups.set(category, await get<Group>(`/${category}/groups`));

  const now = new Date().toISOString();
  for (const code of [...new Set(todo.map((i) => i.setCode.toUpperCase()))]) {
    const items = todo.filter((i) => i.setCode.toUpperCase() === code);
    // English first; a code only in the Japanese catalog (such as M2a) is looked up there.
    let products: Product[] = [];
    for (const category of CATEGORIES) {
      const sets = groups
        .get(category)!
        .filter((g) => (g.abbreviation ?? "").toUpperCase() === code);
      if (sets.length === 0) continue;
      for (const g of sets)
        products = products.concat(await get<Product>(`/${category}/${g.groupId}/products`));
      break;
    }
    for (const item of items) {
      const product = pickProduct(products, item);
      if (!product) {
        result.notFound.push({ name: item.name, setCode: item.setCode, number: item.number });
        continue;
      }
      db.update(collectionItems)
        .set({
          tcgplayerId: String(product.productId),
          // A new id means a fresh match on the price service.
          priceMatchStatus: null,
          priceVariantId: null,
          priceMatchLabel: null,
          updatedAt: now,
        })
        .where(and(eq(collectionItems.id, item.id), isNull(collectionItems.tcgplayerId)))
        .run();
      result.found++;
    }
  }
  return result;
}
