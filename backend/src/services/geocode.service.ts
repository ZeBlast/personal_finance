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
 *   1. a position already known for the same store or the same street address, or (for a purchase
 *      without a street address) for the same shop's only known branch in that city: nothing is sent,
 *   then, for a purchase with a street address, only:
 *   2. the full street address,             3. the street without its suite or unit;
 *   or, for one without:
 *   4. the shop's name with its city,       5. the postal code (approximate),
 *   6. the city and state (approximate), read from the bank's wording when no city was sent.
 *
 * The server's answers are checked before one is kept (see pickHit): it must be in the state and
 * country asked for, an address must come back as a building or at least its street (a street
 * alone is kept as approximate), and a shop must be a place of business whose name matches.
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
export const GEOCODE_METHOD = 3;
/** How many answers to ask for, to choose the one that fits. */
const CANDIDATES = 5;
const RESET_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const PROJECT_URL = "https://github.com/ZeBlast/personal_finance";

/** `street`: the address was matched to its street only, not the building. */
export type Precision = "address" | "street" | "shop" | "postcode" | "city";
const PRECISIONS: ReadonlySet<string> = new Set(["address", "street", "shop", "postcode", "city"]);
const APPROXIMATE: ReadonlySet<Precision> = new Set(["street", "postcode", "city"]);

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
  /** What the answer has to agree with (not sent as such). */
  expect: { region: string | null; country: string | null; merchant: string | null };
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
 * A shop's name without what a bank or card reader adds around it: a payment service's tag
 * ("SQ *", "TST* "), a store number ("#1234", "STORE 55") or a trailing run of digits. Pure.
 */
export function cleanMerchant(name: string): string {
  const tidy = name
    .trim()
    .replace(/^[A-Za-z]{2,6}\s?\*\s*/, "")
    .replace(/\s+(?:store\s*)?#\s*\d[\w-]*/gi, "")
    .replace(/\s+store\s+\d+\b/gi, "")
    .replace(/\s+\d{3,}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return tidy === "" ? name.trim() : tidy;
}

const CITY_STARTS = new Set(
  "NEW SAN SANTA LOS LAS FORT FT ST SAINT MOUNT MT PORT EL LA NORTH SOUTH EAST WEST N S E W LAKE PALM SALT GRAND CAPE BOCA DES DE CEDAR COSTA LONG LITTLE BATON CORPUS COLORADO KANSAS OKLAHOMA JERSEY VIRGINIA".split(
    " ",
  ),
);
const CITY_ENDS = new Set(
  "CITY BEACH SPRINGS HEIGHTS PARK FALLS HILLS VALLEY GROVE RAPIDS ROCK LAKE ISLAND VEGAS VISTA HARBOR JUNCTION STATION VILLAGE TOWNSHIP RIDGE FOREST BAY POINT".split(
    " ",
  ),
);

export const cityKey = (city: string, region: string | null): string =>
  `${clean(city)}|${clean(region)}`;

/**
 * Cities a bank's wording may end with, before a US state ("... SAN FRANCISCO CA", also with a
 * ZIP code or "US" after it), likeliest first and at most two. The words before the state could be
 * the city or the end of the shop's name, so: a city the bank has named elsewhere (`knownCities`,
 * see cityKey) comes first, then the reading that looks like a city's name ("SAN ...", "... CITY"),
 * then the last word alone. Words of the shop's own name are not taken for a city. Pure.
 */
export function cityFromDescription(
  description: string,
  merchant: string | null = null,
  knownCities: ReadonlySet<string> = new Set(),
): Array<{ city: string; region: string }> {
  const words = description.trim().split(/\s+/);
  if (/^USA?$/i.test(words.at(-1) ?? "")) words.pop();
  if (/^\d{5}(?:-\d{4})?$/.test(words.at(-1) ?? "")) words.pop();
  const region = words.at(-1)?.toUpperCase() ?? "";
  if (!US_STATES.has(region)) return [];
  const own = new Set(
    (merchant ?? "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((w) => w.length >= 3),
  );
  const before: string[] = [];
  for (let i = words.length - 2; i >= 0 && before.length < 3; i -= 1) {
    const w = words[i]!;
    if (!/^[A-Za-z][A-Za-z.'-]+$/.test(w)) break;
    // The last word may be both ("PORTLAND PIZZA PORTLAND OR"); words before it are the shop's.
    if (before.length > 0 && own.has(w.toUpperCase())) break;
    before.unshift(w);
  }
  if (before.length === 0) return [];
  const up = before.map((w) => w.toUpperCase().replace(/\.$/, ""));
  const three = before.length === 3 ? before.join(" ") : null;
  const two = before.length >= 2 ? before.slice(-2).join(" ") : null;
  const one = before.at(-1)!;
  const ranked: string[] = [];
  for (const name of [three, two, one]) {
    if (name && knownCities.has(cityKey(name, region))) ranked.push(name);
  }
  if (three && CITY_STARTS.has(up[0]!) && (CITY_STARTS.has(up[1]!) || CITY_ENDS.has(up[2]!))) {
    ranked.push(three);
  }
  const lastUp = up.at(-1)!;
  const secondUp = up.at(-2);
  if (two && secondUp && (CITY_STARTS.has(secondUp) || CITY_ENDS.has(lastUp))) ranked.push(two);
  ranked.push(one);
  if (two) ranked.push(two);
  return [...new Set(ranked)].slice(0, 2).map((city) => ({ city, region }));
}

/** The cities a purchase may have happened in: the bank's, or those its wording ends with. Pure. */
function citiesOf(
  t: Target,
  knownCities: ReadonlySet<string>,
): Array<{ city: string; region: string | null }> {
  const city = text(t.city);
  if (city) return [{ city, region: text(t.region) }];
  return t.description ? cityFromDescription(t.description, text(t.merchant), knownCities) : [];
}

/** A two-letter country as the filter the server takes, or the country's name as a search term. */
function countryParams(country: string | null): Record<string, string | null> {
  if (country === null) return {};
  return /^[A-Za-z]{2}$/.test(country) ? { countrycodes: country.toLowerCase() } : { country };
}

/** The lookups that could place this purchase, most precise first, each with its own key. Pure. */
export function lookupSteps(t: Target, knownCities: ReadonlySet<string> = new Set()): Step[] {
  const street = text(t.address);
  const city = text(t.city);
  const region = text(t.region);
  const postal = text(t.postalCode);
  const country = text(t.country);
  const merchant = text(t.merchant) ? cleanMerchant(text(t.merchant)!) : null;
  const steps: Step[] = [];
  const add = (
    raw: Record<string, string | null>,
    precision: Precision,
    expect: { region: string | null; country: string | null },
  ): void => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (v) params[k] = v;
    const key = `v${GEOCODE_METHOD}|${Object.keys(params)
      .sort()
      .map((k) => `${k}=${clean(params[k])}`)
      .join("&")}`;
    if (!steps.some((s) => s.key === key)) {
      steps.push({ key, params, precision, expect: { ...expect, merchant } });
    }
  };
  // A purchase with a street address is placed by that address or not at all: never by its
  // shop's name or its postal code or city, which could put it at another branch or nearby.
  if (street) {
    const place = { city, state: region, postalcode: postal, ...countryParams(country) };
    add({ street, ...place }, "address", { region, country });
    const bare = stripUnit(street);
    if (bare !== "" && bare !== street)
      add({ street: bare, ...place }, "address", { region, country });
    return steps;
  }
  // Without a city from the bank, the one at the end of its wording (US only).
  const cities = citiesOf(t, knownCities);
  const within = country ?? (city === null && cities.length > 0 ? "US" : null);
  const first = cities[0];
  if (merchant && first) {
    add(
      {
        q: [merchant, first.city, first.region].filter(Boolean).join(", "),
        ...countryParams(within),
        layer: "poi",
      },
      "shop",
      { region: first.region, country: within },
    );
  }
  if (postal)
    add({ postalcode: postal, ...countryParams(country) }, "postcode", { region, country });
  for (const c of cities) {
    add({ city: c.city, state: c.region, ...countryParams(within) }, "city", {
      region: c.region,
      country: within,
    });
  }
  return steps;
}

const squash = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
const GENERIC_WORDS = new Set(
  "the and inc llc ltd company store shop for restaurant cafe market".split(" "),
);

/** Whether a place's name could be this shop's ("McDonald's" for "MCDONALDS 4471"). Pure. */
export function sameShop(merchant: string, placeName: string): boolean {
  const m = squash(merchant);
  const h = squash(placeName);
  if (m === "" || h === "") return false;
  if (h.includes(m) || (h.length >= 4 && m.includes(h))) return true;
  const words = merchant
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  return words.some((w) => h.includes(w));
}

/** Kinds of thing on the map that are never a shop. */
const NOT_A_SHOP = new Set(["boundary", "place", "highway", "waterway", "natural", "landuse"]);

export interface Picked {
  lat: number;
  lon: number;
  matched: string | null;
  precision: Precision;
}

/**
 * The answer to keep for a lookup, from those the server sent (best first by its own ranking), or
 * null when none fits. Each is checked against what was asked, using only the details the server
 * sent along (one that sends none is taken at its word):
 * - anywhere: the country and (in the US) the state must be the ones asked for;
 * - an address: a building or address point is exact; the street alone, or a building with another
 *   house number, counts as `street` (approximate), taken only when no building fits; anything
 *   wider (the city, the postal code) is not the address;
 * - a shop: a place of business, not a street or a town of that name, and its name must match;
 * - a postal code: that postal code; a city: a settlement, not a street or shop named like it.
 * Pure.
 */
export function pickHit(step: Step, body: unknown): Picked | null {
  if (!Array.isArray(body)) return null;
  const asked =
    /^\s*(\d+[A-Za-z]?)\b/.exec(step.params["street"] ?? "")?.[1]?.toLowerCase() ?? null;
  let streetOnly: Picked | null = null;
  for (const raw of body) {
    if (typeof raw !== "object" || raw === null) continue;
    const hit = raw as Record<string, unknown>;
    const lat = Number(hit["lat"]);
    const lon = Number(hit["lon"]);
    if (
      hit["lat"] == null ||
      hit["lon"] == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      continue;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const address = (
      typeof hit["address"] === "object" && hit["address"] !== null ? hit["address"] : {}
    ) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    const display = str(hit["display_name"]);
    const rank = typeof hit["place_rank"] === "number" ? hit["place_rank"] : null;
    const category = str(hit["category"]) ?? str(hit["class"]);
    const countryCode = str(address["country_code"])?.toLowerCase() ?? null;
    const stateCode = str(address["ISO3166-2-lvl4"])?.toUpperCase() ?? null;

    const { region, country, merchant } = step.expect;
    if (
      country &&
      /^[A-Za-z]{2}$/.test(country) &&
      countryCode &&
      countryCode !== country.toLowerCase()
    ) {
      continue;
    }
    if (
      region &&
      US_STATES.has(region.toUpperCase()) &&
      stateCode?.startsWith("US-") &&
      stateCode !== `US-${region.toUpperCase()}`
    ) {
      continue;
    }
    const at = { lat, lon, matched: display };
    if (step.precision === "address") {
      if (rank !== null && rank < 26) continue;
      const number = str(address["house_number"])?.toLowerCase() ?? null;
      const wrongNumber =
        asked !== null && number !== null && !number.split(/[^0-9a-z]+/).includes(asked);
      const building = (rank === null || rank >= 28) && !wrongNumber && category !== "highway";
      if (building) return { ...at, precision: "address" };
      streetOnly ??= { ...at, precision: "street" };
      continue;
    }
    if (step.precision === "shop") {
      if (category !== null && NOT_A_SHOP.has(category)) continue;
      if (rank !== null && rank < 28) continue;
      const name = str(hit["name"]) ?? display;
      if (merchant && name && !sameShop(merchant, name)) continue;
      return { ...at, precision: "shop" };
    }
    if (step.precision === "postcode") {
      const want = squash(step.params["postalcode"] ?? "");
      const got = squash(str(address["postcode"]) ?? "");
      if (want !== "" && got !== "" && !got.startsWith(want) && !want.startsWith(got)) continue;
      return { ...at, precision: "postcode" };
    }
    if (rank !== null && rank > 25) continue;
    return { ...at, precision: "city" };
  }
  return streetOnly;
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
const shopCityKey = (
  merchant: string | null,
  city: string,
  region: string | null,
): string | null =>
  text(merchant) ? `${squash(cleanMerchant(merchant!))}|${cityKey(city, region)}` : null;
const streetKey = (r: LocatedRow): string | null =>
  text(r.address) ? `${clean(r.address)}|${clean(r.city)}|${clean(r.region)}` : null;

/** Two positions this close are taken for the same shop (degrees: about 150 m). */
const SAME_SPOT = 0.0015;

/**
 * Positions the bank already sent: by store and by street, to place the same store elsewhere, and
 * by shop and city where every position the bank sent for that shop in that city is the same
 * spot (its only branch the user goes to there). Also every city the bank has named.
 */
function knownPositions(db: AppDb, environment: string) {
  const rows = db.all<LocatedRow & { lat: number | null; lon: number | null }>(sql`
    select coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as merchant,
      t.location_store_number as store, t.location_address as address, t.location_city as city,
      t.location_region as region, t.location_lat as lat, t.location_lon as lon
    from transactions t
      join accounts a on a.id = t.account_id
      left join plaid_items p on p.id = a.plaid_item_id
    where ((t.location_lat is not null and t.location_lon is not null)
        or t.location_city is not null)
      and (p.environment = ${environment} or a.plaid_item_id is null)
    group by 1, 2, 3, 4, 5, 6, 7
  `);
  const byStore = new Map<string, Resolved>();
  const byStreet = new Map<string, Resolved>();
  const byShopCity = new Map<string, Resolved | null>();
  const cities = new Set<string>();
  for (const r of rows) {
    const city = text(r.city);
    if (city) cities.add(cityKey(city, r.region));
    if (r.lat === null || r.lon === null) continue;
    const at = { lat: r.lat, lon: r.lon, approx: false };
    const s = storeKey(r);
    if (s && !byStore.has(s)) byStore.set(s, at);
    const st = streetKey(r);
    if (st && !byStreet.has(st)) byStreet.set(st, at);
    const sc = city ? shopCityKey(r.merchant, city, r.region) : null;
    if (sc) {
      const seen = byShopCity.get(sc);
      if (seen === undefined) byShopCity.set(sc, at);
      else if (
        seen !== null &&
        (Math.abs(seen.lat - at.lat) > SAME_SPOT || Math.abs(seen.lon - at.lon) > SAME_SPOT)
      ) {
        byShopCity.set(sc, null); // more than one branch: no telling which
      }
    }
  }
  return { byStore, byStreet, byShopCity, cities };
}

type Answer = { lat: number | null; lon: number | null; precision: string | null };

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
  for (const r of rows) stepsOf.set(r, lookupSteps(r, known.cities));
  const answers = savedAnswers(db, [...new Set([...stepsOf.values()].flat().map((s) => s.key))]);
  const placed = new Map<R, Resolved | null>();
  const waiting = new Set<R>();
  const next = new Map<string, Step>();
  for (const r of rows) {
    let reuse =
      known.byStore.get(storeKey(r) ?? "") ?? known.byStreet.get(streetKey(r) ?? "") ?? null;
    // Never for a purchase with a street address: that one is placed by its address only.
    if (!reuse && !text(r.address)) {
      for (const c of citiesOf(r, known.cities)) {
        reuse = known.byShopCity.get(shopCityKey(r.merchant, c.city, c.region) ?? "") ?? null;
        if (reuse) break;
      }
    }
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
        // How close the answer turned out (an address may have matched only its street).
        const precision =
          answer.precision !== null && PRECISIONS.has(answer.precision)
            ? (answer.precision as Precision)
            : step.precision;
        at = { lat: answer.lat, lon: answer.lon, approx: APPROXIMATE.has(precision) };
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
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", String(CANDIDATES));
    lastRequestAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": agent, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // The server in the settings is the only one asked: never wherever it points on to
        // (which could be a plain http:// address, or one inside this network).
        redirect: "error",
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
    const picked = pickHit(step, body);
    const ok = picked !== null;
    const answer = {
      lat: picked?.lat ?? null,
      lon: picked?.lon ?? null,
      matched: picked?.matched ?? null,
      server,
      lookedUpAt: new Date().toISOString(),
      method: GEOCODE_METHOD,
      precision: picked?.precision ?? step.precision,
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
