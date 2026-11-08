import { randomBytes } from "node:crypto";
import { inArray, lt, sql } from "drizzle-orm";
import { geocodeCache } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import { getSettings, updateSettings } from "./settings.service.js";

/**
 * Finds map positions for purchases that came without coordinates, using everything the bank sent
 * about where they happened: the street address, the shop's name and store number, the city,
 * state, postal code and country, and the bank's own wording ("STARBUCKS #1234 SPRINGFIELD IL").
 *
 * In order, stopping at the first that gives a position:
 *   1. a position already known for the same store or the same street address (nothing is sent),
 *   then, for a purchase with a street address, only:
 *   2. the full street address,             3. the street without its suite or unit;
 *   or, for one without:
 *   4. the shop's name with its city,       5. the postal code (approximate),
 *   6. the city and state (approximate), read from the bank's wording when no city was sent.
 *
 * Lookups use Nominatim (OpenStreetMap's geocoder), whose public server has a strict usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/). This follows it:
 * - Lookups run only when the user starts them (never in the background or on a timer), and only
 *   while the user has turned them on.
 * - One request at a time, at most one every two seconds (the policy's ceiling is one a second),
 *   and at most MAX_PER_RUN in one run: a small, one-time job.
 * - Every answer is kept, including "not found", so the same query is never asked twice. Clearing
 *   them all to ask again is allowed at most once a week.
 * - The first refusal (429, 403, 418), server error or network failure stops the run; nothing is
 *   retried in a loop.
 * - Requests name the app (and this copy's random tag) in the User-Agent. What is sent is about
 *   the shop, never about the user: no amounts, dates or account details.
 * - The server is a setting, so the service can be switched without a new version.
 */

export const MIN_INTERVAL_MS = 2_000;
export const MAX_PER_RUN = 500;
/** The way of looking up; answers saved by an older way are asked again. */
export const GEOCODE_METHOD = 2;
const RESET_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const PROJECT_URL = "https://github.com/ZeBlast/personal_finance";

export type Precision = "address" | "shop" | "postcode" | "city";
const APPROXIMATE: ReadonlySet<Precision> = new Set(["postcode", "city"]);

/** What is known about where a purchase happened. */
export interface Target {
  merchant: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  description: string | null;
}

export interface Step {
  key: string;
  params: Record<string, string>;
  precision: Precision;
}

const text = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t === "" ? null : t;
};
const clean = (s: string | null | undefined): string => (text(s) ?? "").toLowerCase();

/** A street without a trailing suite, unit, apartment or floor ("100 Main St Ste 200"). Pure. */
export function stripUnit(street: string): string {
  return street
    .replace(
      /[,\s]+(?:#\s*[\w-]+|(?:ste|suite|apt|apartment|unit|bldg|building|fl|floor|rm|room)\.?\s*#?\s*[\w-]+)\s*$/i,
      "",
    )
    .trim();
}

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(
    " ",
  ),
);

/**
 * Cities a bank's wording may end with, before a US state ("... SAN FRANCISCO CA"): the last two
 * words, then the last one, when they are plain words. Pure.
 */
export function cityFromDescription(description: string): Array<{ city: string; region: string }> {
  const words = description.trim().split(/\s+/);
  const region = words.at(-1)?.toUpperCase() ?? "";
  if (!US_STATES.has(region)) return [];
  const before: string[] = [];
  for (let i = words.length - 2; i >= 0 && before.length < 2; i -= 1) {
    if (!/^[A-Za-z][A-Za-z.'-]+$/.test(words[i]!)) break;
    before.unshift(words[i]!);
  }
  const out: Array<{ city: string; region: string }> = [];
  if (before.length === 2) out.push({ city: before.join(" "), region });
  if (before.length >= 1) out.push({ city: before.at(-1)!, region });
  return out;
}

/** The lookups that could place this purchase, most precise first, each with its own key. Pure. */
export function lookupSteps(t: Target): Step[] {
  const street = text(t.address);
  const city = text(t.city);
  const region = text(t.region);
  const postal = text(t.postalCode);
  const country = text(t.country);
  const merchant = text(t.merchant);
  const steps: Step[] = [];
  const add = (raw: Record<string, string | null>, precision: Precision): void => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (v) params[k] = v;
    const key = `v${GEOCODE_METHOD}|${Object.keys(params)
      .sort()
      .map((k) => `${k}=${clean(params[k])}`)
      .join("&")}`;
    if (!steps.some((s) => s.key === key)) steps.push({ key, params, precision });
  };
  const place = { city, state: region, postalcode: postal, country };
  // A purchase with a street address is placed by that address or not at all: never by its
  // shop's name or its postal code or city, which could put it at another branch or nearby.
  if (street) {
    add({ street, ...place }, "address");
    const bare = stripUnit(street);
    if (bare !== "" && bare !== street) add({ street: bare, ...place }, "address");
    return steps;
  }
  // Without a city from the bank, the one at the end of its wording (US only).
  const fromWording = city === null && t.description ? cityFromDescription(t.description) : [];
  const cities = city ? [{ city, region }] : fromWording;
  const countryCode = (country ?? (fromWording.length > 0 ? "US" : null))?.toLowerCase() ?? null;
  const first = cities[0];
  if (merchant && first) {
    add(
      {
        q: [merchant, first.city, first.region].filter(Boolean).join(", "),
        countrycodes: countryCode,
      },
      "shop",
    );
  }
  if (postal) add({ postalcode: postal, country }, "postcode");
  for (const c of cities) {
    add({ city: c.city, state: c.region, country: country ?? (city ? null : "US") }, "city");
  }
  return steps;
}

export interface Resolved {
  lat: number;
  lon: number;
  approx: boolean;
}

/** A purchase's location details as stored, with its store number. */
export interface LocatedRow extends Target {
  store: string | null;
}

const storeKey = (r: LocatedRow): string | null =>
  text(r.merchant) && text(r.store) ? `${clean(r.merchant)}#${clean(r.store)}` : null;
const streetKey = (r: LocatedRow): string | null =>
  text(r.address) ? `${clean(r.address)}|${clean(r.city)}|${clean(r.region)}` : null;

/** Positions the bank already sent, by store and by street, to place the same store elsewhere. */
function knownPositions(db: AppDb, environment: string) {
  const rows = db.all<LocatedRow & { lat: number; lon: number }>(sql`
    select coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as merchant,
      t.location_store_number as store, t.location_address as address, t.location_city as city,
      t.location_region as region, t.location_lat as lat, t.location_lon as lon
    from transactions t
      join accounts a on a.id = t.account_id
      left join plaid_items p on p.id = a.plaid_item_id
    where t.location_lat is not null and t.location_lon is not null
      and (p.environment = ${environment} or a.plaid_item_id is null)
  `);
  const byStore = new Map<string, Resolved>();
  const byStreet = new Map<string, Resolved>();
  for (const r of rows) {
    const at = { lat: r.lat, lon: r.lon, approx: false };
    const s = storeKey(r);
    if (s && !byStore.has(s)) byStore.set(s, at);
    const st = streetKey(r);
    if (st && !byStreet.has(st)) byStreet.set(st, at);
  }
  return { byStore, byStreet };
}

type Answer = { lat: number | null; lon: number | null };

/** Saved answers by query key (only those from the current way of looking up). */
function savedAnswers(db: AppDb, keys: string[]): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = db
      .select()
      .from(geocodeCache)
      .where(inArray(geocodeCache.addressKey, keys.slice(i, i + 500)))
      .all();
    for (const r of rows) {
      if (r.method === GEOCODE_METHOD) out.set(r.addressKey, r);
    }
  }
  return out;
}

/**
 * Where each of these purchases goes on the map (null: nowhere yet), which are waiting for a
 * lookup, and the lookups that would place them: for each, its next step not yet asked.
 */
export function resolveRows<R extends LocatedRow>(
  db: AppDb,
  rows: R[],
): { placed: Map<R, Resolved | null>; waiting: Set<R>; next: Map<string, Step> } {
  const environment = getSettings(db).plaidEnvironment;
  const known = knownPositions(db, environment);
  const stepsOf = new Map<R, Step[]>();
  for (const r of rows) stepsOf.set(r, lookupSteps(r));
  const answers = savedAnswers(db, [...new Set([...stepsOf.values()].flat().map((s) => s.key))]);
  const placed = new Map<R, Resolved | null>();
  const waiting = new Set<R>();
  const next = new Map<string, Step>();
  for (const r of rows) {
    const reuse =
      known.byStore.get(storeKey(r) ?? "") ?? known.byStreet.get(streetKey(r) ?? "") ?? null;
    if (reuse) {
      placed.set(r, reuse);
      continue;
    }
    let at: Resolved | null = null;
    for (const step of stepsOf.get(r)!) {
      const answer = answers.get(step.key);
      if (!answer) {
        waiting.add(r);
        next.set(step.key, step);
        break;
      }
      if (answer.lat !== null && answer.lon !== null) {
        at = { lat: answer.lat, lon: answer.lon, approx: APPROXIMATE.has(step.precision) };
        break;
      }
    }
    placed.set(r, at);
  }
  return { placed, waiting, next };
}

/** Purchases without coordinates, grouped by their location details, with how many share each. */
function unplacedRows(db: AppDb): Array<LocatedRow & { n: number }> {
  const environment = getSettings(db).plaidEnvironment;
  return db.all<LocatedRow & { n: number }>(sql`
    select coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as merchant,
      t.location_store_number as store, t.location_address as address, t.location_city as city,
      t.location_region as region, t.location_postal_code as postalCode,
      t.location_country as country, t.original_description as description, count(*) as n
    from transactions t
      join accounts a on a.id = t.account_id
      left join plaid_items p on p.id = a.plaid_item_id
    where (t.location_lat is null or t.location_lon is null)
      and (p.environment = ${environment} or a.plaid_item_id is null)
    group by 1, 2, 3, 4, 5, 6, 7, 8
  `);
}

type Stop = "cancelled" | "refused" | "failed" | "limit";

export interface GeocodeStatus {
  enabled: boolean;
  server: string;
  running: boolean;
  /** This run: lookups to make (it grows when one finds nothing and the next is tried), done, found. */
  total: number;
  done: number;
  found: number;
  notFound: number;
  /** Lookups waiting to be made. */
  pending: number;
  /** Purchases that a lookup could still place. */
  unplaced: number;
  /** Why the last run ended early, or null when it finished (or none has run). */
  stopped: Stop | null;
  message: string | null;
  /** When every answer can next be cleared to ask again, or null when it can be now. */
  resetAvailableAt: string | null;
}

export interface GeocoderOptions {
  version: string;
  fetchImpl?: typeof fetch | undefined;
  /** Waits; tests pass one that returns at once. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  maxPerRun?: number | undefined;
}

export interface Geocoder {
  status(): GeocodeStatus;
  /** Starts a run (or does nothing when one is running). Refuses while lookups are turned off. */
  start(): Promise<void>;
  /** Stops the run after the request in flight. */
  stop(): void;
  /** Forgets every saved answer so all are asked again; at most once a week, never mid-run. */
  reset(): void;
  /** Resolves when no run is going. */
  idle(): Promise<void>;
}

export function createGeocoder(db: AppDb, options: GeocoderOptions): Geocoder {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxPerRun = options.maxPerRun ?? MAX_PER_RUN;
  /** The app's name and project (what the policy asks for), plus this copy's random tag. */
  const userAgent = (): string => {
    let tag = getSettings(db).geocodeInstallId;
    if (tag === null) {
      tag = randomBytes(4).toString("hex");
      updateSettings(db, { geocodeInstallId: tag });
    }
    return `PersonalFinance/${options.version} (+${PROJECT_URL}; install ${tag})`;
  };
  // Kept across runs, so starting again right away still waits the interval.
  let lastRequestAt = -Infinity;
  let run: Promise<void> | null = null;
  let cancel = false;
  const state = {
    total: 0,
    done: 0,
    found: 0,
    notFound: 0,
    stopped: null as Stop | null,
    message: null as string | null,
  };
  const end = (stopped: Stop, message: string): void => {
    state.stopped = stopped;
    state.message = message;
  };

  const waitingNow = () => {
    const { waiting, next } = resolveRows(db, unplacedRows(db));
    let unplaced = 0;
    for (const r of waiting) unplaced += r.n;
    return { next, unplaced };
  };

  async function lookUp(server: string, agent: string, step: Step): Promise<"ok" | "stop"> {
    await sleep(Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now()));
    if (cancel) {
      end("cancelled", "Stopped. The rest will be looked up when you start again.");
      return "stop";
    }
    const url = new URL(`${server.replace(/\/+$/, "")}/search`);
    for (const [k, v] of Object.entries(step.params)) url.searchParams.set(k, v);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    lastRequestAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": agent, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      end("failed", "Could not reach the address lookup server. Try again later.");
      return "stop";
    }
    if ([403, 418, 429].includes(response.status)) {
      end("refused", "The address lookup server asked us to stop for now. Try again later.");
      return "stop";
    }
    if (!response.ok) {
      end("failed", `The address lookup server answered with an error (${response.status}).`);
      return "stop";
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      end("failed", "The address lookup server sent an answer that could not be read.");
      return "stop";
    }
    const hit = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
    const lat = hit ? Number(hit["lat"]) : NaN;
    const lon = hit ? Number(hit["lon"]) : NaN;
    const ok = Number.isFinite(lat) && Number.isFinite(lon);
    const answer = {
      lat: ok ? lat : null,
      lon: ok ? lon : null,
      matched: ok && typeof hit?.["display_name"] === "string" ? hit["display_name"] : null,
      server,
      lookedUpAt: new Date().toISOString(),
      method: GEOCODE_METHOD,
      precision: step.precision,
    };
    db.insert(geocodeCache)
      .values({ addressKey: step.key, ...answer })
      .onConflictDoUpdate({ target: geocodeCache.addressKey, set: answer })
      .run();
    state.done += 1;
    if (ok) state.found += 1;
    else state.notFound += 1;
    return "ok";
  }

  return {
    status() {
      const settings = getSettings(db);
      const { next, unplaced } = waitingNow();
      const resetAt = settings.geocodeResetAt ? Date.parse(settings.geocodeResetAt) : null;
      const available =
        resetAt !== null && resetAt + RESET_EVERY_MS > Date.now()
          ? new Date(resetAt + RESET_EVERY_MS).toISOString()
          : null;
      return {
        enabled: settings.geocodeEnabled,
        server: settings.geocodeServer,
        running: run !== null,
        ...state,
        pending: next.size,
        unplaced,
        resetAvailableAt: available,
      };
    },
    async start() {
      const settings = getSettings(db);
      if (!settings.geocodeEnabled) {
        throw new AppError(409, "geocoding_off", "Turn on address lookups first.");
      }
      if (run) return;
      // Answers from an older way of looking up are asked again.
      db.delete(geocodeCache).where(lt(geocodeCache.method, GEOCODE_METHOD)).run();
      const agent = userAgent();
      Object.assign(state, {
        total: waitingNow().next.size,
        done: 0,
        found: 0,
        notFound: 0,
        stopped: null,
        message: null,
      });
      cancel = false;
      const asked = new Set<string>();
      run = (async () => {
        // Each round asks the next step for every purchase still waiting; one that finds nothing
        // brings its next step into the following round.
        for (;;) {
          const next = [...waitingNow().next.values()].filter((s) => !asked.has(s.key));
          if (next.length === 0) return;
          state.total = state.done + next.length;
          for (const step of next) {
            if (asked.size >= maxPerRun) {
              end("limit", `Made ${asked.size} lookups. Start again for the next ones.`);
              return;
            }
            asked.add(step.key);
            if ((await lookUp(settings.geocodeServer, agent, step)) === "stop") return;
          }
        }
      })()
        .catch(() => end("failed", "Address lookups stopped after an unexpected problem."))
        .finally(() => {
          run = null;
        });
    },
    stop() {
      cancel = true;
    },
    reset() {
      if (run) throw new AppError(409, "geocoding_running", "Wait for the lookups to finish.");
      const last = getSettings(db).geocodeResetAt;
      if (last !== null && Date.parse(last) + RESET_EVERY_MS > Date.now()) {
        throw new AppError(
          409,
          "reset_too_soon",
          "Every address can be looked up again once a week at most, so the lookup server is not asked the same thing over and over.",
        );
      }
      db.delete(geocodeCache).run();
      updateSettings(db, { geocodeResetAt: new Date().toISOString() });
      Object.assign(state, {
        total: 0,
        done: 0,
        found: 0,
        notFound: 0,
        stopped: null,
        message: null,
      });
    },
    async idle() {
      while (run) await run;
    },
  };
}
