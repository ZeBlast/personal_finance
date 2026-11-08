import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { transactions } from "../../drizzle/schema.js";
import { addressKey, createGeocoder, MIN_INTERVAL_MS } from "./services/geocode.service.js";
import { placesData } from "./services/places.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("addressKey", () => {
  it("is the same for the same address written differently", () => {
    const a = addressKey({
      address: " 100  Main St ",
      city: "Springfield",
      region: "IL",
      postalCode: "62701",
      country: "US",
    });
    const b = addressKey({
      address: "100 main st",
      city: "SPRINGFIELD",
      region: "il",
      postalCode: "62701",
      country: "us",
    });
    expect(a).toBe(b);
    expect(
      addressKey({
        address: null,
        city: "Springfield",
        region: "IL",
        postalCode: null,
        country: "US",
      }),
    ).toBeNull();
  });
});

interface Call {
  url: URL;
  userAgent: string | null;
}

/** A fake Nominatim: answers from `answers` by street, or with `status`. */
function fakeNominatim(answers: Record<string, { lat: string; lon: string } | null>, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    if (status !== 200) return new Response("slow down", { status });
    const hit = answers[url.searchParams.get("street") ?? ""];
    const body = hit ? [{ lat: hit.lat, lon: hit.lon, display_name: "Somewhere" }] : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function withAddresses() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const checking = (
    await t.call("post", "/api/accounts/manual").send({ name: "Checking", kind: "checking" })
  ).body.id as number;
  const buy = async (date: string, merchant: string, address: string | null) => {
    const id = (
      await t
        .call("post", "/api/transactions")
        .send({ accountId: checking, date, merchant, amountMinor: 1_000, direction: "out" })
        .expect(201)
    ).body.id as number;
    t.db
      .update(transactions)
      .set({
        locationAddress: address,
        locationCity: "Springfield",
        locationRegion: "IL",
        locationPostalCode: "62701",
        locationCountry: "US",
      })
      .where(eq(transactions.id, id))
      .run();
  };
  await buy("2026-10-01", "Corner Cafe", "100 Main St");
  await buy("2026-10-02", "Corner Cafe", "100 Main St");
  await buy("2026-10-03", "Hardware Barn", "9 Elm Ave");
  await buy("2026-10-04", "Online Thing", null);
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

describe("the geocoder", () => {
  it("does nothing while lookups are turned off", async () => {
    const t = await withAddresses();
    await t.call("post", "/api/geocode/start").expect(409);
    const status = await t.call("get", "/api/geocode/status").expect(200);
    expect(status.body).toMatchObject({ enabled: false, pending: 2, running: false });
  });

  it("asks once per address, spaced out, and keeps every answer", async () => {
    const t = await withAddresses();
    await t.call("patch", "/api/settings").send({ geocodeEnabled: true }).expect(200);
    const fake = fakeNominatim({
      "100 Main St": { lat: "39.80", lon: "-89.64" },
      "9 Elm Ave": null,
    });
    const { g, waits } = geocoderFor(t, fake.fetchImpl);

    await g.start();
    await g.idle();
    // Two addresses, though three purchases have one.
    expect(fake.calls).toHaveLength(2);
    expect(g.status()).toMatchObject({
      running: false,
      total: 2,
      done: 2,
      found: 1,
      notFound: 1,
      stopped: null,
    });
    // Never two requests closer than the interval (the first needs no wait).
    expect(waits.filter((w) => w > 0).every((w) => w >= MIN_INTERVAL_MS - 50)).toBe(true);
    expect(waits.length).toBeGreaterThanOrEqual(1);

    const first = fake.calls[0]!;
    expect(first.userAgent).toMatch(/^PersonalFinance\/9\.9\.9 \(\+https:\/\/github\.com\//);
    expect(first.url.origin + first.url.pathname).toBe(
      "https://nominatim.openstreetmap.org/search",
    );
    expect(Object.fromEntries(first.url.searchParams)).toMatchObject({
      city: "Springfield",
      state: "IL",
      postalcode: "62701",
      country: "US",
      format: "jsonv2",
      limit: "1",
    });
    // Only the shop's address: no merchant name, amount or date.
    expect(first.url.search).not.toMatch(/cafe|hardware|1000|2026/i);

    // The places now have the coordinates found.
    const places = placesData(t.db, { from: "2026-10-01", to: "2026-10-31" });
    const cafe = places.purchases.filter((p) => p.merchant === "Corner Cafe");
    expect(cafe.every((p) => p.lat === 39.8 && p.lon === -89.64)).toBe(true);
    expect(places.withPlace).toBe(2);

    // Asked again, nothing is sent: found and not found are both remembered.
    await g.start();
    await g.idle();
    expect(fake.calls).toHaveLength(2);
    expect(g.status().pending).toBe(0);
  });

  it("names the app and this copy's own random tag, the same every time", async () => {
    const t = await withAddresses();
    await t.call("patch", "/api/settings").send({ geocodeEnabled: true }).expect(200);
    const fake = fakeNominatim({});
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    const agents = new Set(fake.calls.map((c) => c.userAgent));
    expect(agents.size).toBe(1);
    const agent = [...agents][0]!;
    expect(agent).toMatch(
      /^PersonalFinance\/9\.9\.9 \(\+https:\/\/github\.com\/ZeBlast\/personal_finance; install [0-9a-f]{8}\)$/,
    );
    const tag = agent.match(/install ([0-9a-f]{8})/)![1];
    const settings = await t.call("get", "/api/settings").expect(200);
    expect(settings.body.geocodeInstallId).toBe(tag);

    // Another copy of the app gets its own tag.
    const other = await withAddresses();
    await other.call("patch", "/api/settings").send({ geocodeEnabled: true }).expect(200);
    const fake2 = fakeNominatim({});
    const { g: g2 } = geocoderFor(other, fake2.fetchImpl);
    await g2.start();
    await g2.idle();
    expect(fake2.calls[0]!.userAgent).not.toContain(tag);
  });

  it("stops at the first refusal and keeps the rest for later", async () => {
    const t = await withAddresses();
    await t.call("patch", "/api/settings").send({ geocodeEnabled: true }).expect(200);
    const fake = fakeNominatim({}, 429);
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls).toHaveLength(1);
    expect(g.status()).toMatchObject({ running: false, done: 0, stopped: "refused" });
    expect(g.status().pending).toBe(2);
  });

  it("asks the server in the settings", async () => {
    const t = await withAddresses();
    await t
      .call("patch", "/api/settings")
      .send({ geocodeEnabled: true, geocodeServer: "https://geo.example.org/nominatim" })
      .expect(200);
    const fake = fakeNominatim({});
    const { g } = geocoderFor(t, fake.fetchImpl);
    await g.start();
    await g.idle();
    expect(fake.calls[0]!.url.href).toMatch(/^https:\/\/geo\.example\.org\/nominatim\/search\?/);
  });
});
