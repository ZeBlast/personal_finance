import { afterEach, describe, expect, it } from "vitest";
import { appSettings, collectionItems } from "../../drizzle/schema.js";
import { pickVariant, sameNumber, type ApiCard } from "./services/card-price.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const variant = (
  id: string,
  printing: string,
  price: number | null,
  condition = "Lightly Played",
) => ({
  id,
  uuid: `${id}-uuid`,
  condition,
  printing,
  price,
  priceHistory: [
    { p: (price ?? 1) * 0.8, t: Date.UTC(2026, 8, 1) / 1000 },
    { p: price ?? 1, t: Date.UTC(2026, 9, 1) / 1000 },
  ],
});

const PIKACHU: ApiCard = {
  id: "pokemon-mew-pikachu",
  name: "Pikachu",
  set_name: "Scarlet & Violet: 151",
  number: "025/165",
  variants: [
    variant("pika_other_nm", "Normal", 0.5, "Near Mint"),
    variant("pika_nm_normal", "Normal", 0.75),
    variant("pika_nm_rev", "Reverse Holofoil", 1.25),
  ],
};
const ODDISH: ApiCard[] = [
  {
    id: "oddish",
    name: "Erika's Oddish",
    number: "001/217",
    variants: [variant("odd_nm", "Normal", 0.1)],
  },
  {
    id: "oddish-ball",
    name: "Erika's Oddish (Poke Ball Pattern)",
    number: "001/217",
    variants: [variant("oddball_nm", "Holofoil", 2)],
  },
];

describe("matching a card to JustTCG", () => {
  it("compares numbers without leading zeros", () => {
    expect(sameNumber("025/165", "25/165")).toBe(true);
    expect(sameNumber("025/165", "026/165")).toBe(false);
  });

  it("prefers Lightly Played and the regular printing", () => {
    const hit = pickVariant([PIKACHU], {
      name: "Pikachu",
      variant: "",
      number: "025/165",
      condition: null,
    });
    expect(hit?.variant.id).toBe("pika_nm_normal");
  });

  it("prices a card's own condition when it has one", () => {
    const hit = pickVariant([PIKACHU], {
      name: "Pikachu",
      variant: "",
      number: "025/165",
      condition: "NM",
    });
    expect(hit?.variant.id).toBe("pika_other_nm");
  });

  it("picks the reverse holo when the export says so", () => {
    const hit = pickVariant([PIKACHU], {
      name: "Pikachu",
      variant: "Reverse Holofoil",
      number: "25/165",
      condition: null,
    });
    expect(hit?.variant.id).toBe("pika_nm_rev");
  });

  it("uses the variant to choose between cards with the same number", () => {
    const item = { name: "Erika's Oddish", number: "001/217", condition: null };
    expect(pickVariant(ODDISH, { ...item, variant: "Poke Ball" })?.card.id).toBe("oddish-ball");
    expect(pickVariant(ODDISH, { ...item, variant: "" })?.card.id).toBe("oddish");
  });

  it("finds nothing for a different number and name", () => {
    expect(
      pickVariant([PIKACHU], { name: "Mew", variant: "", number: "151/165", condition: null }),
    ).toBeNull();
  });
});

/** A fake JustTCG: answers searches and batches, and counts requests. */
/** A fake tcgcsv.com catalog: sets by code, and their products. Off unless given. */
type Catalog = Record<string, Array<{ productId: number; name: string; number: string }>>;

function fakeJustTcg(cards: ApiCard[], usedBefore = 0, catalog: Catalog | null = null) {
  const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = [];
  const catalogCalls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://tcgcsv.com/")) {
      catalogCalls.push(url);
      if (!catalog) return new Response("down", { status: 503 });
      const codes = Object.keys(catalog);
      const m = /tcgplayer\/(\d+)\/(groups|(\d+)\/products)$/.exec(url)!;
      if (m[1] !== "3") return Response.json({ results: [] });
      if (m[2] === "groups")
        return Response.json({
          results: codes.map((abbreviation, i) => ({
            groupId: 100 + i,
            name: abbreviation,
            abbreviation,
          })),
        });
      const products = catalog[codes[Number(m[3]) - 100]!]!;
      return Response.json({
        results: products.map((p) => ({
          productId: p.productId,
          name: p.name,
          extendedData: [{ name: "Number", value: p.number }],
        })),
      });
    }
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const key = new Headers(init?.headers).get("x-api-key");
    calls.push({ method, url, body, key });
    const meta = {
      apiPlan: "Free",
      apiDailyLimit: 100,
      apiDailyRequestsUsed: usedBefore + calls.length,
    };
    if (key !== "tcg_good_key_123")
      return Response.json({ error: "Invalid API key" }, { status: 401 });
    if (method === "GET") {
      const q = new URL(url).searchParams;
      const name = q.get("q")!.toLowerCase();
      const data = cards.filter((c) => c.name.toLowerCase().includes(name));
      return Response.json({ data, _metadata: meta });
    }
    const lookups = body as Array<{ variantId?: string; tcgplayerId?: string; condition?: string }>;
    const wanted = new Set(lookups.map((b) => b.variantId));
    const products = new Set(lookups.map((b) => b.tcgplayerId).filter(Boolean));
    const data = [
      ...cards
        .map((c) => ({ ...c, variants: c.variants.filter((v) => wanted.has(v.uuid!)) }))
        .filter((c) => c.variants.length > 0),
      ...cards
        .filter((c) => c.tcgplayerId && products.has(c.tcgplayerId))
        .map((c) => ({
          ...c,
          variants: c.variants.filter((v) => v.condition === "Lightly Played"),
        })),
    ];
    return Response.json({ data, _metadata: meta });
  };
  return { calls, catalogCalls, fetchImpl };
}

async function setup(cards: ApiCard[], usedBefore = 0, catalog: Catalog | null = null) {
  const fake = fakeJustTcg(cards, usedBefore, catalog);
  const t = makeTestApp({ cardPriceClient: { fetchImpl: fake.fetchImpl, paceMs: 0 } });
  cleanups.push(t.cleanup);
  const id = (
    await t
      .call("post", "/api/accounts/manual")
      .send({ name: "Cards", kind: "pokemon_cards" })
      .expect(201)
  ).body.id as number;
  await t
    .call("post", `/api/accounts/${id}/collection/import`)
    .send({
      text: "2 Pikachu - 025/165 [MEW] 025/165\n1 Erika's Oddish (Poke Ball) - 001/217 [ASC] 001/217\n1 Missingno [XYZ] 000/000\n",
    })
    .expect(200);
  const run = async (limit?: number) => {
    await t
      .call("post", `/api/accounts/${id}/collection/prices/update`)
      .send(limit ? { limit } : {})
      .expect(202);
    for (let i = 0; i < 100; i++) {
      const s = (await t.call("get", `/api/accounts/${id}/collection/prices/status`).expect(200))
        .body;
      if (!s.running) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("run did not finish");
  };
  const collection = async () =>
    (await t.call("get", `/api/accounts/${id}/collection`).expect(200)).body;
  return { t, id, fake, run, collection };
}

describe("card price runs", () => {
  it("keep the API key secret and refuse to run without it", async () => {
    const { t, id } = await setup([]);
    expect((await t.call("get", "/api/card-prices/key").expect(200)).body).toEqual({
      saved: false,
    });
    await t.call("post", `/api/accounts/${id}/collection/prices/update`).send({}).expect(400);
    const put = await t
      .call("put", "/api/card-prices/key")
      .send({ apiKey: "tcg_good_key_123" })
      .expect(200);
    expect(JSON.stringify(put.body)).not.toContain("tcg_good");
    expect((await t.call("get", "/api/card-prices/key").expect(200)).body).toEqual({ saved: true });
  });

  it("find each card with one request that also prices it, then refresh in batches", async () => {
    const { t, id, fake, run, collection } = await setup([PIKACHU, ...ODDISH]);
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
    const cost = (await t.call("get", `/api/accounts/${id}/collection/prices/cost`).expect(200))
      .body;
    expect(cost).toMatchObject({ toFind: 3, toRefresh: 0, requests: 3 });
    const status = await run();
    expect(status).toMatchObject({
      phase: "done",
      matched: 2,
      notFound: 1,
      priced: 2,
      error: null,
    });
    // One search per card, and no batch: the searches brought the prices.
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
    expect(status).toMatchObject({ requests: 3, dailyRemaining: 97 });

    const c = await collection();
    const pika = c.items.find((i: { name: string }) => i.name === "Pikachu");
    expect(pika).toMatchObject({
      marketPriceMinor: 75,
      unitValueMinor: 75,
      valueSource: "market",
      priceMatchStatus: "matched",
    });
    expect(c.totalValueMinor).toBe(2 * 75 + 200);
    const missing = c.items.find((i: { name: string }) => i.name === "Missingno");
    expect(missing).toMatchObject({ priceMatchStatus: "not_found", unitValueMinor: null });

    const history = (
      await t.call("get", `/api/accounts/${id}/collection/items/${pika.id}/prices`).expect(200)
    ).body;
    expect(history[0]).toEqual({ day: "2026-09-01", priceMinor: 60 });

    // Right away again: everything is up to date, so no requests at all.
    const again = await run();
    expect(again).toMatchObject({ upToDate: 2, requests: 0 });
    expect(fake.calls).toHaveLength(3);

    // A day later: both found cards in one batch request; the missing one is not searched again.
    t.db.update(collectionItems).set({ priceUpdatedAt: "2026-01-01T00:00:00.000Z" }).run();
    await run();
    expect(fake.calls.slice(3).map((x) => x.method)).toEqual(["POST"]);
    expect((fake.calls.at(-1)!.body as unknown[]).length).toBe(2);
  });

  it("stop at the daily allowance and carry on later", async () => {
    const { t, run, fake, collection } = await setup([PIKACHU, ...ODDISH], 99);
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
    const day = new Date().toISOString().slice(0, 10);
    const usage = {
      day,
      month: day.slice(0, 7),
      usedToday: 99,
      usedThisMonth: 99,
      apiDailyRemaining: null,
      apiMonthlyRemaining: null,
    };
    t.db
      .insert(appSettings)
      .values({ key: "justtcg_usage", value: JSON.stringify(usage), updatedAt: day })
      .run();
    const s = await run();
    expect(fake.calls).toHaveLength(1);
    expect(s.stoppedReason).toMatch(/today's JustTCG requests are used up/);
    expect(
      (await collection()).items.filter(
        (i: { priceMatchStatus: string | null }) => i.priceMatchStatus === null,
      ),
    ).toHaveLength(2);
  });

  it("stop at the monthly allowance", async () => {
    const { t, run, fake } = await setup([PIKACHU]);
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
    const day = new Date().toISOString().slice(0, 10);
    const usage = {
      day,
      month: day.slice(0, 7),
      usedToday: 0,
      usedThisMonth: 1000,
      apiDailyRemaining: null,
      apiMonthlyRemaining: null,
    };
    t.db
      .insert(appSettings)
      .values({ key: "justtcg_usage", value: JSON.stringify(usage), updatedAt: day })
      .run();
    const s = await run();
    expect(fake.calls).toHaveLength(0);
    expect(s.stoppedReason).toMatch(/this month's/);
  });

  it("leave a value typed by hand alone", async () => {
    const { t, id, run, collection } = await setup([PIKACHU]);
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
    const pika = (await collection()).items.find((i: { name: string }) => i.name === "Pikachu");
    const { name, variant: v, setCode, number, quantity } = pika;
    await t
      .call("put", `/api/accounts/${id}/collection/items/${pika.id}`)
      .send({ name, variant: v, setCode, number, quantity, unitValueMinor: 5_000 })
      .expect(200);
    await run();
    const after = (await collection()).items.find((i: { name: string }) => i.name === "Pikachu");
    expect(after).toMatchObject({
      unitValueMinor: 5_000,
      valueSource: "manual",
      marketPriceMinor: 75,
    });
  });

  it("only take the first items in a test run", async () => {
    const { t, run, fake } = await setup([PIKACHU, ...ODDISH]);
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
    const s = await run(1);
    expect(s.itemsInRun).toBe(1);
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("report a rejected key", async () => {
    const { t, run } = await setup([PIKACHU]);
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_wrong_key_99" }).expect(200);
    const s = await run();
    expect(s.error).toMatch(/rejected the API key/);
  });
});

describe("TCGplayer ids", () => {
  const CATALOG: Catalog = {
    MEW: [{ productId: 501, name: "Pikachu", number: "025/165" }],
    ASC: [
      { productId: 601, name: "Erika's Oddish", number: "001/217" },
      { productId: 602, name: "Erika's Oddish (Poke Ball)", number: "001/217" },
      { productId: 603, name: "Erika's Oddish (Master Ball Pattern)", number: "001/217" },
    ],
  };
  const withIds = [
    { ...PIKACHU, tcgplayerId: "501" },
    { ...ODDISH[1]!, tcgplayerId: "602" },
  ];

  it("are looked up on import by set code and number, the variant choosing between versions", async () => {
    const { t, id, collection } = await setup([], 0, CATALOG);
    // The import already looked them up; asking again finds nothing new.
    const r = (await t.call("post", `/api/accounts/${id}/collection/tcgplayer-ids`).expect(200))
      .body;
    expect(r).toMatchObject({ found: 0, alreadyKnown: 2 });
    expect(r.notFound).toEqual([{ name: "Missingno", setCode: "XYZ", number: "000/000" }]);
    const items = (await collection()).items as Array<{ name: string; tcgplayerId: string | null }>;
    expect(items.find((i) => i.name === "Pikachu")?.tcgplayerId).toBe("501");
    expect(items.find((i) => i.name === "Erika's Oddish")?.tcgplayerId).toBe("602");
  });

  it("let a run price every card with an id in one batch request", async () => {
    const { t, id, fake, run, collection } = await setup(withIds, 0, CATALOG);
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
    await t.call("post", `/api/accounts/${id}/collection/tcgplayer-ids`).expect(200);
    const cost = (await t.call("get", `/api/accounts/${id}/collection/prices/cost`).expect(200))
      .body;
    // Two cards in one batch, plus one search for the card without an id.
    expect(cost).toMatchObject({ toFind: 1, toRefresh: 2, requests: 2, withoutId: 1 });
    const s = await run();
    expect(s).toMatchObject({ matched: 2, priced: 2, notFound: 1, error: null });
    expect(fake.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(fake.calls[0]!.body).toEqual([
      { tcgplayerId: "602", condition: "LP" },
      { tcgplayerId: "501", condition: "LP" },
    ]);
    const items = (await collection()).items;
    expect(items.find((i: { name: string }) => i.name === "Pikachu")).toMatchObject({
      marketPriceMinor: 75,
      priceMatchStatus: "matched",
    });
    expect(items.find((i: { name: string }) => i.name === "Erika's Oddish").marketPriceMinor).toBe(
      200,
    );
  });

  it("are looked up for free at the start of a run, for cards still without one", async () => {
    const { t, fake, run } = await setup(withIds, 0, CATALOG);
    t.db.update(collectionItems).set({ tcgplayerId: null }).run();
    await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
    const s = await run();
    expect(s.idsFound).toBe(2);
    expect(fake.catalogCalls.length).toBeGreaterThan(0);
    expect(fake.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
});

describe("clearing prices", () => {
  it("undoes a run but keeps TCGplayer ids and values typed in", async () => {
    const { t, id, run, collection } = await setup([PIKACHU], 0, {
      MEW: [{ productId: 501, name: "Pikachu", number: "025/165" }],
    });
    PIKACHU.tcgplayerId = "501";
    try {
      await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
      await run();
      const before = await collection();
      expect(before.totalValueMinor).toBe(150);
      const accountBalance = async () =>
        (
          (await t.call("get", "/api/accounts").expect(200)).body as Array<{
            id: number;
            currentBalanceMinor: number;
          }>
        ).find((a) => a.id === id)!.currentBalanceMinor;
      expect(await accountBalance()).toBe(150);

      const r = (await t.call("post", `/api/accounts/${id}/collection/prices/clear`).expect(200))
        .body;
      expect(r).toEqual({ cleared: 1 });
      const after = await collection();
      const pika = after.items.find((i: { name: string }) => i.name === "Pikachu");
      expect(pika).toMatchObject({
        tcgplayerId: "501",
        marketPriceMinor: null,
        unitValueMinor: null,
        priceMatchStatus: null,
        valueSource: null,
      });
      expect(after.totalValueMinor).toBe(0);
      expect(await accountBalance()).toBe(0);
      const history = (
        await t.call("get", `/api/accounts/${id}/collection/items/${pika.id}/prices`).expect(200)
      ).body;
      expect(history).toEqual([]);
      // No balance points are left from the prices.
      const snaps = t.sqlite
        .prepare("select current_balance_minor as v from balance_snapshots where account_id = ?")
        .all(id) as Array<{ v: number }>;
      expect(snaps.every((s) => s.v === 0)).toBe(true);
    } finally {
      delete PIKACHU.tcgplayerId;
    }
  });
});

describe("collection files", () => {
  it("move a priced collection to another copy of the app, without the API key", async () => {
    const { t, id, run, collection } = await setup([PIKACHU], 0, {
      MEW: [{ productId: 501, name: "Pikachu", number: "025/165" }],
    });
    PIKACHU.tcgplayerId = "501";
    try {
      await t.call("put", "/api/card-prices/key").send({ apiKey: "tcg_good_key_123" }).expect(200);
      await run();
      const before = await collection();
      const file = (await t.call("get", `/api/accounts/${id}/collection/export`).expect(200)).body;
      expect(JSON.stringify(file)).not.toContain("tcg_good_key_123");
      expect(file).toMatchObject({ format: "personal-finance-collection", type: "pokemon" });

      // Another copy of the app: no key, nothing looked up.
      const other = makeTestApp();
      cleanups.push(other.cleanup);
      const made = (await other.call("post", "/api/collections/import").send(file).expect(201))
        .body;
      expect(made).toMatchObject({
        type: "pokemon",
        totalValueMinor: before.totalValueMinor,
        totalQuantity: before.totalQuantity,
      });
      const pika = made.items.find((i: { name: string }) => i.name === "Pikachu");
      expect(pika).toMatchObject({
        tcgplayerId: "501",
        condition: "LP",
        marketPriceMinor: 75,
        priceMatchStatus: "matched",
      });
      const history = (
        await other
          .call("get", `/api/accounts/${made.accountId}/collection/items/${pika.id}/prices`)
          .expect(200)
      ).body;
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect((await other.call("get", "/api/card-prices/key").expect(200)).body).toEqual({
        saved: false,
      });
      const acct = (
        (await other.call("get", "/api/accounts").expect(200)).body as Array<{
          id: number;
          currentBalanceMinor: number;
        }>
      ).find((a) => a.id === made.accountId)!;
      expect(acct.currentBalanceMinor).toBe(before.totalValueMinor);
    } finally {
      delete PIKACHU.tcgplayerId;
    }
  });

  it("refuse a file that is not a collection", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t.call("post", "/api/collections/import").send({ hello: "world" }).expect(400);
  });
});
