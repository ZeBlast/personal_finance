import { inArray, sql } from "drizzle-orm";
import { geocodeCache } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import { randomBytes } from "node:crypto";
import { getSettings, updateSettings } from "./settings.service.js";

/**
 * Finds coordinates for purchases whose bank sent a street address but no latitude and longitude,
 * with Nominatim (OpenStreetMap's geocoder), so they can go on the Places map.
 *
 * Nominatim's public server has a strict usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/). This follows it:
 * - Lookups run only when the user starts them (never in the background or on a timer), and only
 *   while the user has turned them on in settings.
 * - One request at a time, at most one every two seconds (the policy's ceiling is one a second),
 *   and at most MAX_PER_RUN in one run: a small, one-time job.
 * - Every answer is kept, including "not found", so the same address is never asked twice.
 * - The first refusal (429, 403, 418), server error or network failure stops the run. Nothing is
 *   retried in a loop; the rest waits until the user starts again.
 * - Requests name the app (and this copy's random tag) in the User-Agent. Only the shop's street address, city, state, postal
 *   code and country are sent: never the merchant, amounts, dates or anything about the user.
 * - The server is a setting, so the service can be switched without a new version.
 */

export const MIN_INTERVAL_MS = 2_000;
export const MAX_PER_RUN = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const PROJECT_URL = "https://github.com/ZeBlast/personal_finance";

export interface AddressParts {
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

const clean = (s: string | null): string => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** One address, however it was written; null without a street address (those are not looked up). */
export function addressKey(a: AddressParts): string | null {
  if (clean(a.address) === "") return null;
  return [a.address, a.city, a.region, a.postalCode, a.country].map(clean).join("|");
}

type Stop = "cancelled" | "refused" | "failed" | "limit";

export interface GeocodeStatus {
  enabled: boolean;
  server: string;
  running: boolean;
  /** This run: how many to look up, how many done, and what they found. */
  total: number;
  done: number;
  found: number;
  notFound: number;
  /** Addresses not looked up yet. */
  pending: number;
  /** Why the last run ended early, or null when it finished (or none has run). */
  stopped: Stop | null;
  message: string | null;
}

interface Pending {
  key: string;
  parts: AddressParts;
}

/** Street addresses on purchases with no coordinates that have not been looked up yet. */
export function pendingAddresses(db: AppDb): Pending[] {
  const environment = getSettings(db).plaidEnvironment;
  const rows = db.all<{
    address: string | null;
    city: string | null;
    region: string | null;
    postal: string | null;
    country: string | null;
  }>(sql`
    select distinct t.location_address as address, t.location_city as city,
      t.location_region as region, t.location_postal_code as postal, t.location_country as country
    from transactions t
      join accounts a on a.id = t.account_id
      left join plaid_items p on p.id = a.plaid_item_id
    where trim(coalesce(t.location_address, '')) <> ''
      and (t.location_lat is null or t.location_lon is null)
      and (p.environment = ${environment} or a.plaid_item_id is null)
  `);
  const byKey = new Map<string, Pending>();
  for (const r of rows) {
    const parts = {
      address: r.address,
      city: r.city,
      region: r.region,
      postalCode: r.postal,
      country: r.country,
    };
    const key = addressKey(parts);
    if (key !== null && !byKey.has(key)) byKey.set(key, { key, parts });
  }
  const keys = [...byKey.keys()];
  const known = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    for (const r of db
      .select({ key: geocodeCache.addressKey })
      .from(geocodeCache)
      .where(inArray(geocodeCache.addressKey, chunk))
      .all()) {
      known.add(r.key);
    }
  }
  return [...byKey.values()].filter((p) => !known.has(p.key));
}

/** Coordinates already found for these addresses. */
export function cachedCoordinates(
  db: AppDb,
  keys: string[],
): Map<string, { lat: number; lon: number }> {
  const out = new Map<string, { lat: number; lon: number }>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = db
      .select()
      .from(geocodeCache)
      .where(inArray(geocodeCache.addressKey, keys.slice(i, i + 500)))
      .all();
    for (const r of rows) {
      if (r.lat !== null && r.lon !== null) out.set(r.addressKey, { lat: r.lat, lon: r.lon });
    }
  }
  return out;
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
  /** Resolves when no run is going. */
  idle(): Promise<void>;
}

export function createGeocoder(db: AppDb, options: GeocoderOptions): Geocoder {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxPerRun = options.maxPerRun ?? MAX_PER_RUN;
  /**
   * The app's name and project, which is what the usage policy asks for, plus this copy's random
   * tag (made once and kept), so the server can tell copies apart without anything personal.
   */
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

  async function lookUp(server: string, agent: string, p: Pending): Promise<"ok" | "stop"> {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    await sleep(wait);
    if (cancel) {
      end("cancelled", "Stopped. The rest will be looked up when you start again.");
      return "stop";
    }
    const url = new URL(`${server.replace(/\/+$/, "")}/search`);
    const params: Array<[string, string | null]> = [
      ["street", p.parts.address],
      ["city", p.parts.city],
      ["state", p.parts.region],
      ["postalcode", p.parts.postalCode],
      ["country", p.parts.country],
    ];
    for (const [name, value] of params) {
      if (value && value.trim() !== "") url.searchParams.set(name, value.trim());
    }
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
    db.insert(geocodeCache)
      .values({
        addressKey: p.key,
        lat: ok ? lat : null,
        lon: ok ? lon : null,
        matched: ok && typeof hit?.["display_name"] === "string" ? hit["display_name"] : null,
        server,
        lookedUpAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    state.done += 1;
    if (ok) state.found += 1;
    else state.notFound += 1;
    return "ok";
  }

  return {
    status() {
      const settings = getSettings(db);
      return {
        enabled: settings.geocodeEnabled,
        server: settings.geocodeServer,
        running: run !== null,
        ...state,
        pending: pendingAddresses(db).length,
      };
    },
    async start() {
      const settings = getSettings(db);
      if (!settings.geocodeEnabled) {
        throw new AppError(409, "geocoding_off", "Turn on address lookups first.");
      }
      if (run) return;
      const todo = pendingAddresses(db);
      const batch = todo.slice(0, maxPerRun);
      Object.assign(state, {
        total: batch.length,
        done: 0,
        found: 0,
        notFound: 0,
        stopped: null,
        message: null,
      });
      cancel = false;
      const agent = userAgent();
      run = (async () => {
        for (const p of batch) {
          if ((await lookUp(settings.geocodeServer, agent, p)) === "stop") return;
        }
        if (todo.length > batch.length) {
          end("limit", `Looked up ${batch.length}. Start again for the next ones.`);
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
    async idle() {
      while (run) await run;
    },
  };
}
