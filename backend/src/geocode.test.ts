import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { geocodeCache, transactions } from "../../drizzle/schema.js";
import {
  cityFromDescription,
  createGeocoder,
  lookupSteps,
  MIN_INTERVAL_MS,
  stripUnit,
} from "./services/geocode.service.js";
import { placesData } from "./services/places.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("tidying what is looked up", () => {
  it("drops a suite or unit from a street", () => {
    expect(stripUnit("100 Main St Ste 200")).toBe("100 Main St");
    expect(stripUnit("100 Main St #4B")).toBe("100 Main St");
    expect(stripUnit("100 Main St, Suite 5")).toBe("100 Main St");
    expect(stripUnit("12 Elm Rd Apt 3")).toBe("12 Elm Rd");
    expect(stripUnit("12 Elm Rd")).toBe("12 Elm Rd");
  });

  it("reads a city and state from the end of the bank's wording", () => {
    expect(cityFromDescription("STARBUCKS #1234 SPRINGFIELD IL")).toEqual([
      { city: "SPRINGFIELD", region: "IL" },
    ]);
    expect(cityFromDescription("SQ *TACO TRUCK SAN FRANCISCO CA")).toEqual([
      { city: "SAN FRANCISCO", region: "CA" },
      { city: "FRANCISCO", region: "CA" },
    ]);
    expect(cityFromDescription("NETFLIX.COM")).toEqual([]);
    expect(cityFromDescription("PAYMENT THANK YOU XX")).toEqual([]);
  });

  it("looks up a purchase with a street address only by that address", () => {
    const steps = lookupSteps({
      merchant: "Corner Cafe",
      address: "100 Main St Ste 2",
      city: "Springfield",
      region: "IL",
      postalCode: "62701",
      country: "US",
      description: null,
    });
    expect(steps.map((s) => s.precision)).toEqual(["address", "address"]);
    expect(steps[0]!.params).toMatchObject({ street: "100 Main St Ste 2", city: "Springfield" });
    expect(steps[1]!.params).toMatchObject({ street: "100 Main St" });
  });

  it("without a street, tries the shop, then the postcode and city", () => {
    const steps = lookupSteps({
      merchant: "Corner Cafe",
      address: null,
      city: "Springfield",
      region: "IL",
      postalCode: "62701",
      country: "US",
      description: null,
    });
    expect(steps.map((s) => s.precision)).toEqual(["shop", "postcode", "city"]);
    expect(steps[0]!.params).toMatchObject({
      q: "Corner Cafe, Springfield, IL",
      countrycodes: "us",
    });
    expect(steps[1]!.params).toEqual({ postalcode: "62701", country: "US" });
    expect(steps[2]!.params).toEqual({ city: "Springfield", state: "IL", country: "US" });
    expect(new Set(steps.map((s) => s.key)).size).toBe(3);
  });
});

interface Call {
  params: Record<string, string>;
  userAgent: string | null;
  href: string;
}

/**
 * A fake Nominatim. Answers are keyed by what was asked: `street:<street>`, `q:<q>`,
 * `postal:<postcode>` or `city:<city>`; anything else finds nothing.
 */
function fakeNominatim(answers: Record<string, [number, number]>, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const params = Object.fromEntries(url.searchParams);
    calls.push({ params, userAgent: new Headers(init?.headers).get("user-agent"), href: url.href });
    if (status !== 200) return new Response("slow down", { status });
    const key = params["q"]
      ? `q:${params["q"]}`
      : params["street"]
        ? `street:${params["street"]}`
        : params["city"]
          ? `city:${params["city"]}`
          : `postal:${params["postalcode"]}`;
    const hit = answers[key];
    const body = hit ? [{ lat: String(hit[0]), lon: String(hit[1]), display_name: key }] : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

interface Buy {
  date?: string;
  merchant: string;
  store?: string | null;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  postal?: string | null;
  country?: string | null;
  description?: string | null;
  online?: boolean;
  at?: [number, number];
}

async function withPurchases(buys: Buy[]) {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const checking = (
    await t.call("post", "/api/accounts/manual").send({ name: "Checking", kind: "checking" })
  ).body.id as number;
  for (const b of buys) {
    const id = (
      await t
        .call("post", "/api/transactions")
        .send({
          accountId: checking,
          date: b.date ?? "2026-10-01",
          merchant: b.merchant,
          amountMinor: 1_000,
          direction: "out",
        })
        .expect(201)
    ).body.id as number;
    t.db
      .update(transactions)
      .set({
        locationStoreNumber: b.store ?? null,
        locationAddress: b.address ?? null,
        locationCity: b.city ?? null,
        locationRegion: b.region ?? null,
        locationPostalCode: b.postal ?? null,
        locationCountry: b.country ?? null,
        originalDescription: b.description ?? null,
        paymentChannel: b.online ? "online" : "in store",
        locationLat: b.at?.[0] ?? null,
        locationLon: b.at?.[1] ?? null,
      })
      .where(eq(transactions.id, id))
      .run();
  }
  await t.call("patch", "/api/settings").send({ geocodeEnabled: true }).expect(200);
  return t;
}

function geocoderFor(t: ReturnType<typeof makeTestApp>, fetchImpl: typeof fetch) {
  const waits: number[] = [];
  const g = createGeocoder(t.db, {
    fetchImpl,
    version: "9.9.9",
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { g, waits };
}

const place = (t: ReturnType<typeof makeTestApp>, merchant: string) =>
  placesData(t.db, { from: "2026-09-01", to: "2026-10-31" }).purchases.find(
    (p) => p.merchant === merchant,
  )!;

const springfield = { city: "Springfield", region: "IL", postal: "62701", country: "US" };

describe("the geocoder", () => {
  it("does nothing while lookups are turned off", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield },
    ]);
    await t.call("patch", "/api/settings").send({ geocodeEnabled: false }).expect(200);
    await t.call("post", "/api/geocode/start").expect(409);
    const status = await t.call("get", "/api/geocode/status").expect(200);
    expect(status.body).toMatchObject({ enabled: false, unplaced: 1, running: false });
  });

  it("asks once per address, spaced out, names the app, and keeps every answer", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield },
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield, date: "2026-10-02" },
      { merchant: "Hardware Barn", address: "9 Elm Ave", ...springfield },
    ]);
    const fake = fakeNominatim({
      "street:100 Main St": [39.8, -89.64],
      "street:9 Elm Ave": [39.79, -89.6],
    });
    const { g, waits } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls).toHaveLength(2);
    expect(waits.filter((w) => w > 0).every((w) => w >= MIN_INTERVAL_MS - 50)).toBe(true);
    expect(fake.calls[0]!.userAgent).toMatch(
      /^PersonalFinance\/9\.9\.9 \(\+https:\/\/github\.com\/ZeBlast\/personal_finance; install [0-9a-f]{8}\)$/,
    );
    expect(fake.calls[0]!.href).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
    expect(fake.calls[0]!.params).toMatchObject({ format: "jsonv2", limit: "1" });
    expect(place(t, "Corner Cafe")).toMatchObject({ lat: 39.8, lon: -89.64, approx: false });

    await g.start();
    await g.idle();
    expect(fake.calls).toHaveLength(2);
    expect(g.status()).toMatchObject({ pending: 0, unplaced: 0 });
  });

  it("leaves a purchase with an address off the map when the address is not found", async () => {
    const t = await withPurchases([
      { merchant: "Dentist", address: "100 Nowhere Rd Ste 9", ...springfield },
    ]);
    // The shop and postcode would be found, but are never asked.
    const fake = fakeNominatim({
      "q:Dentist, Springfield, IL": [39.7, -89.6],
      "postal:62701": [39.79, -89.65],
    });
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(
      fake.calls.map((c) => c.params["street"] ?? c.params["q"] ?? c.params["postalcode"]),
    ).toEqual(["100 Nowhere Rd Ste 9", "100 Nowhere Rd"]);
    expect(place(t, "Dentist")).toMatchObject({ lat: null, lon: null });
    expect(g.status()).toMatchObject({ pending: 0, unplaced: 0 });
  });

  it("tries the street without its unit when the full address is not found", async () => {
    const t = await withPurchases([
      { merchant: "Dentist", address: "100 Main St Ste 200", ...springfield },
    ]);
    const fake = fakeNominatim({ "street:100 Main St": [39.8, -89.64] });
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls.map((c) => c.params["street"])).toEqual([
      "100 Main St Ste 200",
      "100 Main St",
    ]);
    expect(place(t, "Dentist")).toMatchObject({ lat: 39.8, approx: false });
  });

  it("uses a position already known for the same store, without asking", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", store: "12", ...springfield, at: [39.81, -89.65] },
      { merchant: "Corner Cafe", store: "12", date: "2026-10-05" },
    ]);
    const fake = fakeNominatim({});
    const { g } = geocoderFor(t, fake.fetchImpl);
    expect(g.status()).toMatchObject({ pending: 0, unplaced: 0 });
    await g.start();
    await g.idle();
    expect(fake.calls).toHaveLength(0);
    const both = placesData(t.db, { from: "2026-09-01", to: "2026-10-31" }).purchases;
    expect(both.every((p) => p.lat === 39.81 && p.approx === false)).toBe(true);
  });

  it("falls back from the shop to the postcode, and marks that position approximate", async () => {
    const t = await withPurchases([{ merchant: "Taco Truck", ...springfield }]);
    const fake = fakeNominatim({ "postal:62701": [39.79, -89.65] });
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls.map((c) => c.params["q"] ?? c.params["postalcode"])).toEqual([
      "Taco Truck, Springfield, IL",
      "62701",
    ]);
    expect(place(t, "Taco Truck")).toMatchObject({ lat: 39.79, approx: true });
  });

  it("reads the city from the bank's wording when the bank sent no location", async () => {
    const t = await withPurchases([
      { merchant: "Starbucks", description: "STARBUCKS #1234 SPRINGFIELD IL" },
    ]);
    const fake = fakeNominatim({ "city:SPRINGFIELD": [39.78, -89.65] });
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls[0]!.params["q"]).toBe("Starbucks, SPRINGFIELD, IL");
    expect(fake.calls.at(-1)!.params).toMatchObject({ city: "SPRINGFIELD", state: "IL" });
    expect(place(t, "Starbucks")).toMatchObject({ lat: 39.78, approx: true });
  });

  it("asks again for answers saved by an older way of looking up", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield },
    ]);
    const fake = fakeNominatim({ "street:100 Main St": [39.8, -89.64] });
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    t.db.update(geocodeCache).set({ method: 1 }).run();
    expect(g.status().pending).toBe(1);
    await g.start();
    await g.idle();
    expect(fake.calls).toHaveLength(2);
  });

  it("stops at the first refusal and keeps the rest for later", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield },
      { merchant: "Hardware Barn", address: "9 Elm Ave", ...springfield },
    ]);
    const fake = fakeNominatim({}, 429);
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls).toHaveLength(1);
    expect(g.status()).toMatchObject({ running: false, done: 0, stopped: "refused", pending: 2 });
  });

  it("asks the server in the settings", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield },
    ]);
    await t
      .call("patch", "/api/settings")
      .send({ geocodeServer: "https://geo.example.org/nominatim" })
      .expect(200);
    const fake = fakeNominatim({});
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls[0]!.href).toMatch(/^https:\/\/geo\.example\.org\/nominatim\/search\?/);
  });

  it("forgets every answer when asked to look everything up again, once a week at most", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield },
    ]);
    const fake = fakeNominatim({ "street:100 Main St": [39.8, -89.64] });
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(g.status().pending).toBe(0);
    g.reset();
    expect(g.status()).toMatchObject({ pending: 1 });
    expect(g.status().resetAvailableAt).not.toBeNull();
    expect(() => g.reset()).toThrow(/once a week/);
  });

  it("says which purchases were made online", async () => {
    const t = await withPurchases([
      { merchant: "Shop", ...springfield, at: [39.8, -89.6] },
      { merchant: "Web Store", online: true },
    ]);
    expect(place(t, "Web Store").online).toBe(true);
    expect(place(t, "Shop").online).toBe(false);
  });
});
