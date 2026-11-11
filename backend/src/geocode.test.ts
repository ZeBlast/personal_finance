import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { geocodeCache, transactions } from "../../drizzle/schema.js";
import {
  cityFromDescription,
  cleanMerchant,
  createGeocoder,
  lookupSteps,
  MIN_INTERVAL_MS,
  pickHit,
  sameShop,
  stripUnit,
} from "./services/geocode.service.js";
import { placesData } from "./services/places.service.js";
import type { Step } from "./services/geocode.service.js";
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
    // A ZIP code or "US" after the state, and a three-word city.
    expect(cityFromDescription("TRADER JOES 552 SALT LAKE CITY UT 84101 US")[0]).toEqual({
      city: "SALT LAKE CITY",
      region: "UT",
    });
    // The shop's own name is not the city, and a plain last word comes before two.
    expect(cityFromDescription("BLUE BOTTLE OAKLAND CA", "Blue Bottle")).toEqual([
      { city: "OAKLAND", region: "CA" },
    ]);
    expect(cityFromDescription("JOES DINER OAKLAND CA")[0]).toEqual({
      city: "OAKLAND",
      region: "CA",
    });
    // A city the bank has named elsewhere wins.
    expect(
      cityFromDescription("JOES DINER WALNUT CREEK CA", null, new Set(["walnut creek|ca"]))[0],
    ).toEqual({ city: "WALNUT CREEK", region: "CA" });
    // A phone number where the city would be: bought online, no city.
    expect(cityFromDescription("SPOTIFY 877-778-1161 NY")).toEqual([]);
    expect(cityFromDescription("NETFLIX.COM")).toEqual([]);
    expect(cityFromDescription("PAYMENT THANK YOU XX")).toEqual([]);
  });

  it("drops what a bank adds around a shop's name", () => {
    expect(cleanMerchant("SQ *TACO TRUCK")).toBe("TACO TRUCK");
    expect(cleanMerchant("TST* Corner Cafe")).toBe("Corner Cafe");
    expect(cleanMerchant("STARBUCKS #1234")).toBe("STARBUCKS");
    expect(cleanMerchant("MCDONALDS 4471")).toBe("MCDONALDS");
    expect(cleanMerchant("Corner Cafe")).toBe("Corner Cafe");
    expect(cleanMerchant("7-Eleven")).toBe("7-Eleven");
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
      layer: "poi",
    });
    expect(steps[1]!.params).toEqual({ postalcode: "62701", countrycodes: "us" });
    expect(steps[2]!.params).toEqual({ city: "Springfield", state: "IL", countrycodes: "us" });
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

describe("choosing among the server's answers", () => {
  const addressStep = lookupSteps({
    merchant: "Corner Cafe",
    address: "100 Main St",
    city: "Springfield",
    region: "IL",
    postalCode: "62701",
    country: "US",
    description: null,
  })[0]!;
  const [shopStep, postalStep, cityStep] = lookupSteps({
    merchant: "MCDONALDS 4471",
    address: null,
    city: "Springfield",
    region: "IL",
    postalCode: "62701",
    country: "US",
    description: null,
  }) as [Step, Step, Step];
  const il = { country_code: "us", "ISO3166-2-lvl4": "US-IL" };
  const hit = (over: Record<string, unknown>) => ({
    lat: "39.8",
    lon: "-89.6",
    display_name: "somewhere",
    ...over,
  });

  it("takes a building for an address, and passes over the same address in another state", () => {
    const mo = hit({
      lat: "37.2",
      place_rank: 30,
      address: { house_number: "100", country_code: "us", "ISO3166-2-lvl4": "US-MO" },
    });
    const right = hit({ place_rank: 30, address: { house_number: "100", ...il } });
    expect(pickHit(addressStep, [mo, right])).toMatchObject({ lat: 39.8, precision: "address" });
    expect(pickHit(addressStep, [mo])).toBeNull();
  });

  it("keeps a street alone as approximate, and only when no building fits", () => {
    const street = hit({ lat: "39.7", place_rank: 26, category: "highway", address: il });
    const otherNumber = hit({
      lat: "39.75",
      place_rank: 30,
      address: { house_number: "950", ...il },
    });
    const building = hit({ place_rank: 30, address: { house_number: "100", ...il } });
    expect(pickHit(addressStep, [street])).toMatchObject({ lat: 39.7, precision: "street" });
    expect(pickHit(addressStep, [otherNumber])).toMatchObject({ precision: "street" });
    expect(pickHit(addressStep, [street, building])).toMatchObject({
      lat: 39.8,
      precision: "address",
    });
  });

  it("does not take the city or postal code for an address", () => {
    expect(
      pickHit(addressStep, [hit({ place_rank: 16, category: "boundary", address: il })]),
    ).toBeNull();
    expect(
      pickHit(addressStep, [hit({ place_rank: 21, category: "place", address: il })]),
    ).toBeNull();
  });

  it("takes for a shop only a place of business with a matching name", () => {
    const road = hit({ place_rank: 26, category: "highway", name: "McDonald Road", address: il });
    const other = hit({ place_rank: 30, category: "amenity", name: "Burger Barn", address: il });
    const real = hit({
      lat: "39.9",
      place_rank: 30,
      category: "amenity",
      name: "McDonald's",
      address: il,
    });
    expect(pickHit(shopStep, [road, other, real])).toMatchObject({ lat: 39.9, precision: "shop" });
    expect(pickHit(shopStep, [road, other])).toBeNull();
    expect(sameShop("Wal-Mart", "Walmart Supercenter")).toBe(true);
    expect(sameShop("7-Eleven", "7 Eleven")).toBe(true);
    expect(sameShop("Corner Cafe", "Hardware Barn")).toBe(false);
  });

  it("checks a postal code and a city are what was asked for", () => {
    expect(pickHit(postalStep, [hit({ address: { postcode: "90210", ...il } })])).toBeNull();
    expect(pickHit(postalStep, [hit({ address: { postcode: "62701", ...il } })])).toMatchObject({
      precision: "postcode",
    });
    expect(
      pickHit(cityStep, [hit({ place_rank: 26, category: "highway", address: il })]),
    ).toBeNull();
    expect(pickHit(cityStep, [hit({ place_rank: 16, address: il })])).toMatchObject({
      precision: "city",
    });
    expect(
      pickHit(cityStep, [hit({ place_rank: 16, address: { country_code: "ca" } })]),
    ).toBeNull();
  });

  it("takes a server that sends no details at its word, and ignores what is not a position", () => {
    expect(pickHit(addressStep, [{ lat: "39.8", lon: "-89.6" }])).toMatchObject({
      precision: "address",
    });
    expect(pickHit(addressStep, [{ lat: "x", lon: "-89.6" }, null, "nope"])).toBeNull();
    expect(pickHit(addressStep, { error: "no" })).toBeNull();
  });
});

describe("the geocoder", () => {
  it("shows an address matched only to its street as approximate", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", address: "100 Main St", ...springfield },
    ]);
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ lat: "39.7", lon: "-89.6", place_rank: 26, category: "highway" }]),
      )) as typeof fetch;
    const { g } = geocoderFor(t, fetchImpl);
    await g.start();
    await g.idle();
    expect(place(t, "Corner Cafe")).toMatchObject({ lat: 39.7, approx: true });
  });

  it("places a shop at its only known branch in the city, without asking", async () => {
    const t = await withPurchases([
      { merchant: "Corner Cafe", ...springfield, at: [39.81, -89.65] },
      { merchant: "Corner Cafe", ...springfield, at: [39.8101, -89.6501], date: "2026-10-03" },
      {
        merchant: "Corner Cafe",
        description: "SQ *CORNER CAFE SPRINGFIELD IL",
        date: "2026-10-05",
      },
      // Two branches of this one: no telling which, so it is looked up.
      { merchant: "Burger Barn", ...springfield, at: [39.7, -89.6] },
      { merchant: "Burger Barn", ...springfield, at: [39.9, -89.7], date: "2026-10-03" },
      { merchant: "Burger Barn", city: "Springfield", region: "IL", date: "2026-10-05" },
    ]);
    const fake = fakeNominatim({});
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls.map((c) => c.params["q"] ?? c.params["city"])).toEqual([
      "Burger Barn, Springfield, IL",
      "Springfield",
    ]);
    const cafes = placesData(t.db, { from: "2026-09-01", to: "2026-10-31" }).purchases.filter(
      (p) => p.merchant === "Corner Cafe",
    );
    expect(cafes.map((p) => p.lat)).toEqual([39.81, 39.8101, 39.81]);
  });

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
    expect(fake.calls[0]!.params).toMatchObject({
      format: "jsonv2",
      limit: "5",
      addressdetails: "1",
    });
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
    t.db.update(geocodeCache).set({ method: 2 }).run();
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
