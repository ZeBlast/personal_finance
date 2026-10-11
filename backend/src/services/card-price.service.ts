import { and, asc, eq, gte } from "drizzle-orm";
import {
  appSettings,
  balanceSnapshots,
  collectionItems,
  collectionPriceHistory,
  credentials,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import { recomputeCollectionValue } from "./collection.service.js";
import type { TokenCipher } from "./crypto.js";
import { findTcgplayerIds } from "./tcgplayer-ids.service.js";

/**
 * Card prices from JustTCG (https://justtcg.com). The free plan allows 100 requests a day and
 * 1,000 a month, so every request counts:
 *
 * 1. Find: one search per card (name and number), once ever. The search already returns the price
 *    and its history, so a card found is a card priced. The chosen variant (condition, printing)
 *    is saved on the item, so it is never searched again.
 * 2. Refresh: cards already found are priced in batches (20 per request on the free plan), and
 *    only when their price is older than a day (prices change daily at most).
 *
 * Requests are spaced out (10 a minute), and a run stops cleanly at the daily or monthly limit;
 * the next run carries on where it stopped.
 */

const API_KEY = "justtcg.api_key";
const USAGE_KEY = "justtcg_usage";
const BASE = "https://api.justtcg.com/v1";
const GAME = "pokemon";
/** Free plan: at most 20 cards per batch request. */
export const BATCH_SIZE = 20;
/** Free plan: 10 requests a minute; a little over 6 seconds apart stays under it. */
export const DEFAULT_PACE_MS = 6_500;
/** Free plan allowances, used until JustTCG reports its own counts. */
export const DAILY_LIMIT = 100;
export const MONTHLY_LIMIT = 1_000;
/** A price fetched less than this long ago is not fetched again. */
const FRESH_MS = 20 * 60 * 60_000;
const HISTORY = "180d";

/** The condition priced when a card doesn't say: Lightly Played. */
export const DEFAULT_CONDITION = "LP";
const CONDITIONS: Record<string, string> = {
  nm: "near mint",
  lp: "lightly played",
  mp: "moderately played",
  hp: "heavily played",
  dmg: "damaged",
};
/** "LP", "lp" or "Lightly Played" → "lightly played". */
export const conditionName = (c: string | null | undefined): string => {
  const w = (c ?? DEFAULT_CONDITION).trim().toLowerCase();
  return CONDITIONS[w] ?? w.replace(/[^a-z0-9]+/g, " ").trim();
};
/** "Lightly Played" → "LP", for lookups. */
const conditionCode = (c: string | null | undefined): string => {
  const name = conditionName(c);
  return (
    Object.entries(CONDITIONS)
      .find(([, n]) => n === name)?.[0]
      .toUpperCase() ?? DEFAULT_CONDITION
  );
};

// ---------- API key (stored encrypted, never sent back) ----------

export function saveCardPriceKey(db: AppDb, cipher: TokenCipher, apiKey: string): void {
  const now = new Date().toISOString();
  const valueEncrypted = cipher.encrypt(apiKey.trim(), API_KEY);
  db.insert(credentials)
    .values({ key: API_KEY, valueEncrypted, updatedAt: now })
    .onConflictDoUpdate({ target: credentials.key, set: { valueEncrypted, updatedAt: now } })
    .run();
}

export function clearCardPriceKey(db: AppDb): void {
  db.delete(credentials).where(eq(credentials.key, API_KEY)).run();
}

export function hasCardPriceKey(db: AppDb): boolean {
  return !!db
    .select({ key: credentials.key })
    .from(credentials)
    .where(eq(credentials.key, API_KEY))
    .get();
}

function loadKey(db: AppDb, cipher: TokenCipher): string {
  const row = db.select().from(credentials).where(eq(credentials.key, API_KEY)).get();
  if (!row) throw new AppError(400, "no_price_key", "Enter your JustTCG API key first.");
  try {
    return cipher.decrypt(row.valueEncrypted, API_KEY);
  } catch {
    throw new AppError(
      400,
      "price_key_unreadable",
      "The saved JustTCG key can't be read (it was saved by another copy of the app). Enter it again.",
    );
  }
}

// ---------- Request allowance ----------

/** What is left of the allowance, kept between runs (JustTCG's own counts when it sends them). */
export interface CardPriceUsage {
  /** UTC day and calendar month the counts below belong to. */
  day: string;
  month: string;
  usedToday: number;
  usedThisMonth: number;
  /** As JustTCG last reported them, or null before it has. */
  apiDailyRemaining: number | null;
  apiMonthlyRemaining: number | null;
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function readUsage(db: Pick<AppDb, "select">, now = new Date()): CardPriceUsage {
  const row = db.select().from(appSettings).where(eq(appSettings.key, USAGE_KEY)).get();
  const day = utcDay(now);
  const month = day.slice(0, 7);
  let u: CardPriceUsage | null;
  try {
    u = row ? (JSON.parse(row.value) as CardPriceUsage) : null;
  } catch {
    u = null;
  }
  const fresh: CardPriceUsage = {
    day,
    month,
    usedToday: 0,
    usedThisMonth: 0,
    apiDailyRemaining: null,
    apiMonthlyRemaining: null,
  };
  if (!u) return fresh;
  return {
    day,
    month,
    usedToday: u.day === day ? u.usedToday : 0,
    usedThisMonth: u.month === month ? u.usedThisMonth : 0,
    // JustTCG's daily count resets at midnight UTC; its monthly one we keep until it says otherwise.
    apiDailyRemaining: u.day === day ? u.apiDailyRemaining : null,
    apiMonthlyRemaining: u.apiMonthlyRemaining,
  };
}

function writeUsage(db: Pick<AppDb, "insert">, u: CardPriceUsage): void {
  const now = new Date().toISOString();
  const value = JSON.stringify(u);
  db.insert(appSettings)
    .values({ key: USAGE_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
    .run();
}

/** Requests left today and this month: JustTCG's counts when known, else the plan's limits. */
export function remaining(u: CardPriceUsage): { today: number; month: number } {
  return {
    today: u.apiDailyRemaining ?? Math.max(0, DAILY_LIMIT - u.usedToday),
    month: u.apiMonthlyRemaining ?? Math.max(0, MONTHLY_LIMIT - u.usedThisMonth),
  };
}

// ---------- API shapes ----------

export interface ApiVariant {
  id: string;
  uuid?: string;
  condition: string;
  printing: string;
  language?: string;
  price: number | null;
  lastKnownPrice?: number | null;
  priceStatus?: string;
  lastUpdated?: number;
  priceHistory?: Array<{ p: number; t: number }>;
}

export interface ApiCard {
  id: string;
  uuid?: string;
  name: string;
  set?: string;
  set_name?: string;
  number?: string;
  tcgplayerId?: string;
  variants: ApiVariant[];
}

interface ApiResponse {
  data?: ApiCard[];
  _metadata?: {
    apiRequestsRemaining?: number;
    apiDailyLimit?: number;
    apiDailyRequestsUsed?: number;
    apiPlan?: string;
  };
  error?: string;
  code?: string;
  message?: string;
}

/** One item of a batch: a variant already matched, or a card by its TCGplayer id. */
export type Lookup = { variantId: string } | { tcgplayerId: string; condition?: string };

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Stops a run: the daily or monthly allowance is used up. */
class QuotaExhausted extends Error {
  constructor(readonly which: "day" | "month") {
    super(which);
  }
}

export interface ClientOptions {
  fetchImpl?: Fetch;
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A small JustTCG client: checks the allowance before each request and records it after, spaces
 * requests out, and retries a per-minute 429 after the wait it asks for.
 */
export function createJustTcgClient(db: AppDb, apiKey: string, options: ClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const paceMs = options.paceMs ?? DEFAULT_PACE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last = 0;
  const usage = { requests: 0, plan: null as string | null };

  async function call(path: string, init: RequestInit = {}): Promise<ApiCard[]> {
    for (let attempt = 0; ; attempt++) {
      const before = readUsage(db);
      const left = remaining(before);
      if (left.today <= 0) throw new QuotaExhausted("day");
      if (left.month <= 0) throw new QuotaExhausted("month");
      const wait = last + paceMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}${path}`, {
          ...init,
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        });
      } catch {
        throw new AppError(
          502,
          "price_unreachable",
          "Couldn't reach JustTCG. Check the internet connection.",
        );
      }
      usage.requests++;
      const body = (await res.json().catch(() => ({}))) as ApiResponse;
      const meta = body._metadata;
      const u = readUsage(db);
      u.usedToday++;
      u.usedThisMonth++;
      if (u.apiDailyRemaining !== null) u.apiDailyRemaining = Math.max(0, u.apiDailyRemaining - 1);
      if (u.apiMonthlyRemaining !== null)
        u.apiMonthlyRemaining = Math.max(0, u.apiMonthlyRemaining - 1);
      if (meta) {
        if (meta.apiPlan) usage.plan = meta.apiPlan;
        if (meta.apiDailyLimit != null && meta.apiDailyRequestsUsed != null) {
          u.apiDailyRemaining = Math.max(0, meta.apiDailyLimit - meta.apiDailyRequestsUsed);
        }
        if (meta.apiRequestsRemaining != null) u.apiMonthlyRemaining = meta.apiRequestsRemaining;
      }
      writeUsage(db, u);
      if (res.ok) return body.data ?? [];
      const text = `${body.code ?? ""} ${body.error ?? ""} ${body.message ?? ""}`;
      if (res.status === 401 || res.status === 403) {
        if (/month/i.test(text)) throw new QuotaExhausted("month");
        if (/limit|quota|exceed/i.test(text)) throw new QuotaExhausted("day");
        throw new AppError(
          400,
          "price_key_rejected",
          "JustTCG rejected the API key. Check it and enter it again.",
        );
      }
      if (res.status === 429) {
        if (/month/i.test(text)) throw new QuotaExhausted("month");
        if (/daily|quota|EXCESSIVE/i.test(text) || attempt >= 3) throw new QuotaExhausted("day");
        const retry = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 2 ** attempt * 10_000);
        continue;
      }
      throw new AppError(
        502,
        "price_error",
        `JustTCG answered ${res.status}: ${text.trim() || "no details"}`,
      );
    }
  }

  return {
    usage,
    /** One request: the cards matching a name (and number), with prices and their history. */
    search(name: string, number: string | null): Promise<ApiCard[]> {
      const q = new URLSearchParams({
        game: GAME,
        q: name,
        limit: "20",
        priceHistoryDuration: HISTORY,
        include_statistics: "7d",
      });
      if (number) q.set("number", number);
      return call(`/cards?${q}`);
    },
    /** One request: up to 20 variants by id, with prices and their history. */
    batch(lookups: Lookup[]): Promise<ApiCard[]> {
      const q = new URLSearchParams({ priceHistoryDuration: HISTORY, include_statistics: "7d" });
      return call(`/cards?${q}`, { method: "POST", body: JSON.stringify(lookups) });
    },
  };
}

export type JustTcgClient = ReturnType<typeof createJustTcgClient>;

// ---------- Matching ----------

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const baseName = (s: string) => words(s.replace(/\([^)]*\)/g, " "));
/** "025/165" and "25/165" are the same number. */
export const sameNumber = (a: string, b: string) => {
  const n = (s: string) =>
    s
      .toLowerCase()
      .split("/")
      .map((p) => p.trim().replace(/^0+(?=\w)/, ""))
      .join("/");
  return n(a) === n(b) || n(a).split("/")[0] === n(b).split("/")[0];
};
const overlap = (a: string, b: string) => {
  const bs = new Set(words(b).split(" ").filter(Boolean));
  return words(a)
    .split(" ")
    .filter((w) => w && bs.has(w)).length;
};

export interface MatchItem {
  name: string;
  variant: string;
  number: string;
  condition: string | null;
}

/** Picks the card and variant (condition, printing) that best fits an item, or null. */
export function pickVariant(
  cards: ApiCard[],
  item: MatchItem,
): { card: ApiCard; variant: ApiVariant } | null {
  let pool = cards.filter((c) => c.variants.length > 0);
  if (item.number) {
    const byNumber = pool.filter((c) => c.number && sameNumber(c.number, item.number));
    // Without a number match, only an exact name will do.
    pool =
      byNumber.length > 0 ? byNumber : pool.filter((c) => baseName(c.name) === words(item.name));
  }
  if (pool.length === 0) return null;
  const cardScore = (c: ApiCard) =>
    (baseName(c.name) === words(item.name) ? 10 : overlap(c.name, item.name)) +
    (item.variant ? overlap(c.name, item.variant) * 3 : /\(/.test(c.name) ? -1 : 0);
  const card = [...pool].sort((a, b) => cardScore(b) - cardScore(a))[0]!;

  const wantCondition = words(conditionName(item.condition));
  const v = item.variant.toLowerCase();
  const printingScore = (p: string) => {
    const pl = p.toLowerCase();
    if (/reverse/.test(v)) return /reverse/.test(pl) ? 20 : 0;
    if (/1st/.test(v)) return /1st/.test(pl) ? 20 : 0;
    let s = item.variant ? overlap(p, item.variant) * 5 : 0;
    if (/reverse/.test(pl)) s -= 3;
    if (pl === "normal") s += 2;
    else if (/holo/.test(pl)) s += 1;
    return s;
  };
  const score = (x: ApiVariant) =>
    (words(x.condition).startsWith(wantCondition) ? 100 : 0) +
    (!x.language || /english/i.test(x.language) ? 50 : 0) +
    printingScore(x.printing) +
    (x.price != null ? 1 : 0);
  const variant = [...card.variants].sort((a, b) => score(b) - score(a))[0]!;
  return { card, variant };
}

// ---------- Runs ----------

export interface PriceRunStatus {
  running: boolean;
  /** "finding", "refreshing", or "done". */
  phase: string;
  itemsInRun: number;
  matched: number;
  notFound: number;
  priced: number;
  /** TCGplayer ids looked up at the start of the run. */
  idsFound: number;
  /** Already priced within the last day, so skipped. */
  upToDate: number;
  requests: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  plan: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Set when the run stopped early (daily or monthly limit). */
  stoppedReason: string | null;
  error: string | null;
}

const runs = new Map<number, PriceRunStatus>();

export function priceRunStatus(accountId: number): PriceRunStatus | null {
  return runs.get(accountId) ?? null;
}

const cents = (dollars: number) => Math.round(dollars * 100);
const label = (c: ApiCard, v: ApiVariant) =>
  [c.name, c.set_name, c.number].filter(Boolean).join(" · ") + ` — ${v.condition}, ${v.printing}`;

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/** Saves a variant's price and history on an item; a value typed by hand is left as it is. */
function applyPrice(tx: Tx, itemId: number, v: ApiVariant, now: string): void {
  const price = v.price ?? v.lastKnownPrice ?? null;
  const market = price === null ? null : cents(price);
  const current = tx
    .select({ valueSource: collectionItems.valueSource })
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))
    .get();
  tx.update(collectionItems)
    .set({
      marketPriceMinor: market,
      priceUpdatedAt: now,
      ...(current?.valueSource !== "manual" && market !== null
        ? { unitValueMinor: market, valueSource: "market" }
        : {}),
    })
    .where(eq(collectionItems.id, itemId))
    .run();
  const points = (v.priceHistory ?? []).map((p) => ({
    day: new Date(p.t * 1000).toISOString().slice(0, 10),
    priceMinor: cents(p.p),
  }));
  if (market !== null) points.push({ day: now.slice(0, 10), priceMinor: market });
  for (const p of points) {
    tx.insert(collectionPriceHistory)
      .values({ itemId, ...p })
      .onConflictDoUpdate({
        target: [collectionPriceHistory.itemId, collectionPriceHistory.day],
        set: { priceMinor: p.priceMinor },
      })
      .run();
  }
}

/**
 * Finds and prices a collection's items. `limit` takes only the first items in the list (the
 * test run uses 20). Runs to the end; read progress with priceRunStatus.
 */
export async function runPriceUpdate(
  db: AppDb,
  client: JustTcgClient,
  accountId: number,
  options: { limit?: number | undefined; status?: PriceRunStatus } = {},
): Promise<PriceRunStatus> {
  const status: PriceRunStatus = options.status ?? newStatus(db);
  runs.set(accountId, status);
  const sync = () => {
    const left = remaining(readUsage(db));
    status.requests = client.usage.requests;
    status.dailyRemaining = left.today;
    status.monthlyRemaining = left.month;
    status.plan = client.usage.plan;
  };
  try {
    let items = db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.accountId, accountId))
      .orderBy(asc(collectionItems.setCode), asc(collectionItems.number), asc(collectionItems.name))
      .all();
    if (options.limit) items = items.slice(0, options.limit);
    status.itemsInRun = items.length;
    const pricedThisRun = new Set<number>();

    // 1. Batches of 20 (one request each): cards with a TCGplayer id not priced yet, and
    //    cards already matched whose price is older than a day.
    status.phase = "refreshing";
    const stale = Date.now() - FRESH_MS;
    type Job = { item: (typeof items)[number]; lookup: Lookup };
    const jobs: Job[] = [];
    for (const i of items) {
      if (i.priceMatchStatus === "matched" && i.priceVariantId) {
        if (i.priceUpdatedAt && Date.parse(i.priceUpdatedAt) > stale) status.upToDate++;
        else jobs.push({ item: i, lookup: { variantId: i.priceVariantId } });
      } else if (i.priceMatchStatus === null && i.tcgplayerId) {
        jobs.push({
          item: i,
          lookup: { tcgplayerId: i.tcgplayerId, condition: conditionCode(i.condition) },
        });
      }
    }
    for (let n = 0; n < jobs.length; n += BATCH_SIZE) {
      const group = jobs.slice(n, n + BATCH_SIZE);
      const cards = await client.batch(group.map((g) => g.lookup));
      sync();
      const byVariant = new Map<string, ApiVariant>();
      const byProduct = new Map<string, ApiCard>();
      for (const c of cards) {
        if (c.tcgplayerId) {
          const known = byProduct.get(c.tcgplayerId);
          byProduct.set(
            c.tcgplayerId,
            known ? { ...known, variants: [...known.variants, ...c.variants] } : c,
          );
        }
        for (const v of c.variants) {
          byVariant.set(v.id, v);
          if (v.uuid) byVariant.set(v.uuid, v);
        }
      }
      const now = new Date().toISOString();
      db.transaction((tx) => {
        for (const { item, lookup } of group) {
          if ("variantId" in lookup) {
            const v = byVariant.get(lookup.variantId);
            if (!v) continue;
            applyPrice(tx, item.id, v, now);
            pricedThisRun.add(item.id);
            continue;
          }
          // By TCGplayer id: the card is known, so only the condition and printing are chosen.
          const card = byProduct.get(lookup.tcgplayerId);
          const hit = card ? pickVariant([card], { ...item, number: "" }) : null;
          tx.update(collectionItems)
            .set(
              hit
                ? {
                    priceMatchStatus: "matched",
                    priceVariantId: hit.variant.uuid ?? hit.variant.id,
                    priceMatchLabel: label(hit.card, hit.variant),
                    updatedAt: now,
                  }
                : { priceMatchStatus: "not_found", updatedAt: now },
            )
            .where(eq(collectionItems.id, item.id))
            .run();
          if (hit) {
            applyPrice(tx, item.id, hit.variant, now);
            pricedThisRun.add(item.id);
            status.matched++;
          } else status.notFound++;
        }
        recomputeCollectionValue(tx, accountId, now);
      });
    }
    status.priced = pricedThisRun.size;

    // 2. Cards without a TCGplayer id: one search each, which also brings the price.
    status.phase = "finding";
    for (const item of items.filter((i) => i.priceMatchStatus === null && !i.tcgplayerId)) {
      const cards = await client.search(item.name, item.number || null);
      sync();
      const hit = pickVariant(cards, item);
      const now = new Date().toISOString();
      db.transaction((tx) => {
        tx.update(collectionItems)
          .set(
            hit
              ? {
                  priceMatchStatus: "matched",
                  priceVariantId: hit.variant.uuid ?? hit.variant.id,
                  priceMatchLabel: label(hit.card, hit.variant),
                  updatedAt: now,
                }
              : { priceMatchStatus: "not_found", updatedAt: now },
          )
          .where(eq(collectionItems.id, item.id))
          .run();
        if (hit) {
          applyPrice(tx, item.id, hit.variant, now);
          recomputeCollectionValue(tx, accountId, now);
        }
      });
      if (hit) {
        status.matched++;
        status.priced++;
      } else status.notFound++;
    }
    status.phase = "done";
  } catch (e) {
    if (e instanceof QuotaExhausted) {
      status.stoppedReason =
        e.which === "month"
          ? "Stopped: this month's JustTCG requests are used up (1,000 on the free plan). It carries on after your monthly reset."
          : "Stopped: today's JustTCG requests are used up (100 on the free plan). Run it again tomorrow to carry on.";
    } else {
      status.error = e instanceof Error ? e.message : String(e);
    }
  } finally {
    sync();
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }
  return status;
}

function newStatus(db: AppDb): PriceRunStatus {
  const left = remaining(readUsage(db));
  return {
    running: true,
    phase: "starting",
    itemsInRun: 0,
    matched: 0,
    notFound: 0,
    priced: 0,
    upToDate: 0,
    idsFound: 0,
    requests: 0,
    dailyRemaining: left.today,
    monthlyRemaining: left.month,
    plan: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stoppedReason: null,
    error: null,
  };
}

/** Starts a run in the background and answers at once with its status. One run per account. */
export function startPriceUpdate(
  db: AppDb,
  cipher: TokenCipher,
  accountId: number,
  options: { limit?: number | undefined; client?: ClientOptions },
): PriceRunStatus {
  if (runs.get(accountId)?.running) {
    throw new AppError(
      409,
      "price_run_busy",
      "Prices are already being updated for this collection.",
    );
  }
  const client = createJustTcgClient(db, loadKey(db, cipher), options.client);
  const status = newStatus(db);
  runs.set(accountId, status);
  void (async () => {
    // Free first: TCGplayer ids for cards without one, so they are priced 20 per request.
    try {
      status.phase = "ids";
      const ids = await findTcgplayerIds(db, accountId, options.client?.fetchImpl);
      status.idsFound = ids.found;
    } catch {
      // Without the catalog, cards are searched for one by one instead.
    }
    await runPriceUpdate(db, client, accountId, { limit: options.limit, status });
  })();
  return status;
}

/**
 * Requests a run would spend, at most: one per 20 cards to price by id or refresh, and one per
 * card that has no TCGplayer id and was never searched for.
 */
export function priceRunCost(db: AppDb, accountId: number, limit?: number) {
  let items = db
    .select({
      status: collectionItems.priceMatchStatus,
      updatedAt: collectionItems.priceUpdatedAt,
      tcgplayerId: collectionItems.tcgplayerId,
    })
    .from(collectionItems)
    .where(eq(collectionItems.accountId, accountId))
    .orderBy(asc(collectionItems.setCode), asc(collectionItems.number), asc(collectionItems.name))
    .all();
  if (limit) items = items.slice(0, limit);
  const stale = Date.now() - FRESH_MS;
  const toFind = items.filter((i) => i.status === null && !i.tcgplayerId).length;
  const toRefresh = items.filter(
    (i) =>
      (i.status === null && i.tcgplayerId) ||
      (i.status === "matched" && !(i.updatedAt && Date.parse(i.updatedAt) > stale)),
  ).length;
  const withoutId = items.filter((i) => !i.tcgplayerId).length;
  const left = remaining(readUsage(db));
  return {
    toFind,
    toRefresh,
    withoutId,
    requests: toFind + Math.ceil(toRefresh / BATCH_SIZE),
    dailyRemaining: left.today,
    monthlyRemaining: left.month,
  };
}

/** Lets an item be found again (after a wrong match, or a change to its name or number). */
export function resetItemMatch(db: AppDb, accountId: number, itemId: number): void {
  db.update(collectionItems)
    .set({ priceMatchStatus: null, priceVariantId: null, priceMatchLabel: null })
    .where(and(eq(collectionItems.id, itemId), eq(collectionItems.accountId, accountId)))
    .run();
}

export function itemPriceHistory(db: AppDb, accountId: number, itemId: number) {
  const item = db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(and(eq(collectionItems.id, itemId), eq(collectionItems.accountId, accountId)))
    .get();
  if (!item) throw new AppError(404, "not_found", "That item was not found.");
  return db
    .select({ day: collectionPriceHistory.day, priceMinor: collectionPriceHistory.priceMinor })
    .from(collectionPriceHistory)
    .where(eq(collectionPriceHistory.itemId, itemId))
    .orderBy(asc(collectionPriceHistory.day))
    .all();
}

/**
 * Undoes price lookups on a collection: matches, market prices, their history, values that came
 * from the market, and the balance points they made. TCGplayer ids and values typed in are kept.
 */
export function clearCollectionPrices(db: AppDb, accountId: number): { cleared: number } {
  const items = db
    .select({ id: collectionItems.id, priceUpdatedAt: collectionItems.priceUpdatedAt })
    .from(collectionItems)
    .where(eq(collectionItems.accountId, accountId))
    .all();
  const firstPriced = items
    .map((i) => i.priceUpdatedAt)
    .filter((d): d is string => !!d)
    .sort()[0];
  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const { id } of items) {
      tx.delete(collectionPriceHistory).where(eq(collectionPriceHistory.itemId, id)).run();
    }
    tx.update(collectionItems)
      .set({ unitValueMinor: null, valueSource: null })
      .where(
        and(eq(collectionItems.accountId, accountId), eq(collectionItems.valueSource, "market")),
      )
      .run();
    tx.update(collectionItems)
      .set({
        priceMatchStatus: null,
        priceVariantId: null,
        priceMatchLabel: null,
        marketPriceMinor: null,
        priceUpdatedAt: null,
      })
      .where(eq(collectionItems.accountId, accountId))
      .run();
    recomputeCollectionValue(tx, accountId, now);
    // The balance points written since the first price came in were the prices' doing (and so is the
    // one just written by going back to no prices).
    if (firstPriced) {
      tx.delete(balanceSnapshots)
        .where(
          and(
            eq(balanceSnapshots.accountId, accountId),
            gte(balanceSnapshots.observedAt, firstPriced),
          ),
        )
        .run();
    }
  });
  runs.delete(accountId);
  return { cleared: items.filter((i) => i.priceUpdatedAt).length };
}
