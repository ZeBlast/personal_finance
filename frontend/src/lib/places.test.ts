import { describe, expect, it } from "vitest";
import type { PlacePurchase } from "../types/places";
import {
  beaconsAt,
  cellKey,
  DARK_STYLE,
  filterPurchases,
  groupPlaces,
  habits,
  LIGHT_STYLE,
  mapStyle,
  paceText,
  recency,
  placedCategories,
  placeKey,
  purchasesAt,
  rhythm,
  UNCATEGORIZED,
  weekdayOf,
} from "./places";

describe("mapStyle", () => {
  it("follows the app unless a theme is chosen", () => {
    expect(mapStyle("auto", true, false)).toEqual({ online: true, url: LIGHT_STYLE, dark: false });
    expect(mapStyle("auto", true, true)).toEqual({ online: true, url: DARK_STYLE, dark: true });
    expect(mapStyle("dark", true, false)).toEqual({ online: true, url: DARK_STYLE, dark: true });
    expect(mapStyle("light", true, true)).toEqual({ online: true, url: LIGHT_STYLE, dark: false });
  });
  it("draws a plain background, light or dark, without map images", () => {
    expect(mapStyle("dark", false, false)).toEqual({ online: false, url: null, dark: true });
    expect(mapStyle("auto", false, false)).toEqual({ online: false, url: null, dark: false });
  });
});

describe("after review of the map's second version", () => {
  const p = (over: Partial<PlacePurchase>): PlacePurchase => ({
    id: Math.floor(Math.random() * 1e9),
    accountId: 1,
    date: "2026-10-05",
    datetime: null,
    merchant: "Cafe",
    amountMinor: 500,
    category: null,
    lat: 40,
    lon: -89,
    approx: false,
    online: false,
    city: null,
    lookupKey: null,
    moveKey: null,
    ...over,
  });

  it("marks a place approximate only when every visit's position is", () => {
    expect(groupPlaces([p({ approx: true }), p({ approx: true })])[0]!.approx).toBe(true);
    expect(groupPlaces([p({ approx: true }), p({ approx: false })])[0]!.approx).toBe(false);
  });

  it("leaves online purchases out unless they are asked for", () => {
    const shop = p({});
    const web = p({ online: true });
    expect(filterPurchases([shop, web], { online: false }).map((x) => x.id)).toEqual([shop.id]);
    expect(filterPurchases([shop, web], { online: true })).toHaveLength(2);
    expect(filterPurchases([shop, web], {})).toHaveLength(2);
  });

  it("pings the purchases of the latest days of a replay, where they happened", () => {
    const old = p({ date: "2026-10-01" });
    const fresh = p({ date: "2026-10-06" });
    const nowhere = p({ date: "2026-10-07", lat: null, lon: null });
    expect(beaconsAt([old, fresh, nowhere], "2026-10-07", 7).map((b) => b.id)).toEqual([
      old.id,
      fresh.id,
    ]);
    expect(beaconsAt([old, fresh, nowhere], "2026-10-07", 3).map((b) => b.id)).toEqual([fresh.id]);
  });
});

let nextId = 1;
const buy = (over: Partial<PlacePurchase>): PlacePurchase => ({
  id: nextId++,
  accountId: 1,
  date: "2026-10-05",
  datetime: null,
  merchant: "Cafe",
  amountMinor: 500,
  category: null,
  lat: 40,
  lon: -89,
  approx: false,
  online: false,
  city: "Springfield",
  lookupKey: null,
  moveKey: null,
  ...over,
});

describe("groupPlaces", () => {
  it("joins visits to the same shop at the same spot, and keeps the months visited", () => {
    const places = groupPlaces([
      buy({ date: "2026-08-01", amountMinor: 400 }),
      buy({ date: "2026-08-20", amountMinor: 600 }),
      buy({ date: "2026-10-02", amountMinor: 1_000 }),
      buy({ merchant: "Cafe", lat: 41, lon: -88 }),
      buy({ merchant: "Online", lat: null, lon: null }),
    ]);
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({
      merchant: "Cafe",
      totalMinor: 2_000,
      visits: 3,
      months: ["2026-08", "2026-10"],
      firstDate: "2026-08-01",
      lastDate: "2026-10-02",
    });
  });
});

describe("recency", () => {
  it("is full for a month, then fades over a year", () => {
    expect(recency("2026-10-01", "2026-10-20")).toBe(1);
    expect(recency("2025-10-01", "2026-10-20")).toBe(0);
    const mid = recency("2026-04-20", "2026-10-20");
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });
});

describe("rhythm", () => {
  it("counts purchases by weekday and local hour, and keeps the ones with no time apart", () => {
    const at = (date: string, hour: number) =>
      new Date(`${date}T${String(hour).padStart(2, "0")}:15:00`).toISOString();
    const r = rhythm([
      buy({ date: "2026-10-05", datetime: at("2026-10-05", 8), amountMinor: 300 }), // a Monday
      buy({ date: "2026-10-12", datetime: at("2026-10-12", 8), amountMinor: 500 }),
      buy({ date: "2026-10-09", datetime: null }), // a Friday, no time
    ]);
    expect(weekdayOf("2026-10-05")).toBe(0);
    expect(r.cells[0]![8]).toEqual({ count: 2, totalMinor: 800 });
    expect(r.noTime[4]).toBe(1);
    expect(r.maxCount).toBe(2);
  });
});

describe("habits", () => {
  it("finds frequent shops and how their pace changed", () => {
    const dates = [
      "2026-01-01",
      "2026-01-03",
      "2026-01-05",
      "2026-01-07",
      "2026-01-11",
      "2026-01-15",
      "2026-01-19",
    ];
    const h = habits(
      [...dates.map((date) => buy({ date })), buy({ merchant: "Rare", date: "2026-01-02" })],
      4,
    );
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ merchant: "Cafe", visits: 7 });
    expect(h[0]!.gapEarlier).toBe(2);
    expect(h[0]!.gapLater).toBe(4);
    expect(paceText(h[0]!)).toBe("every 2 days, slowing to every 4");
  });

  it("describes a steady pace plainly", () => {
    expect(paceText({ merchant: "x", dates: [], visits: 6, gapEarlier: 7, gapLater: 7 })).toBe(
      "every 7 days",
    );
    expect(paceText({ merchant: "x", dates: [], visits: 6, gapEarlier: 8, gapLater: 3 })).toBe(
      "every 8 days, speeding up to every 3",
    );
  });
});

describe("filterPurchases", () => {
  it("keeps purchases in the chosen hours and in view", () => {
    const morning = new Date("2026-10-05T08:15:00").toISOString();
    const night = new Date("2026-10-05T21:15:00").toISOString();
    const a = buy({ datetime: morning, lat: 40, lon: -89 });
    const b = buy({ datetime: night, lat: 40, lon: -89 });
    const c = buy({ datetime: morning, lat: 45, lon: -80 });
    const cells = new Set([cellKey(0, 8)]);
    expect(filterPurchases([a, b, c], { cells }).map((p) => p.id)).toEqual([a.id, c.id]);
    const bounds = { west: -90, south: 39, east: -88, north: 41 };
    expect(filterPurchases([a, b, c], { cells, bounds }).map((p) => p.id)).toEqual([a.id]);
    expect(filterPurchases([a, b, c], {})).toHaveLength(3);
  });
});

describe("a place's purchases", () => {
  it("are those at its shop and spot, newest first", () => {
    const here = { merchant: "Corner Cafe", lat: 39.8001, lon: -89.6501 };
    const all = [
      buy({ ...here, date: "2026-10-01" }),
      buy({ ...here, date: "2026-10-09", lat: 39.8003 }), // the same spot, to about 100 m
      buy({ merchant: "Corner Cafe", lat: 40.2, lon: -89.65, date: "2026-10-08" }), // another branch
      buy({ merchant: "Hardware Barn", lat: 39.8001, lon: -89.6501 }),
      buy({ merchant: "Corner Cafe", lat: null, lon: null }),
    ];
    const key = placeKey(all[0]!)!;
    expect(groupPlaces(all).find((p) => p.key === key)?.visits).toBe(2);
    expect(purchasesAt(all, key).map((p) => p.date)).toEqual(["2026-10-09", "2026-10-01"]);
    expect(placeKey(all[4]!)).toBeNull();
  });
});

describe("narrowing the map to a category", () => {
  const all = [
    buy({ merchant: "Grocer", category: "Groceries", lat: 39.8, lon: -89.6 }),
    buy({ merchant: "Grocer", category: "Groceries", lat: 39.8, lon: -89.6 }),
    buy({ merchant: "Cafe", category: "Dining", lat: 39.81, lon: -89.61 }),
    buy({ merchant: "Stall", category: null, lat: 39.82, lon: -89.62 }),
    buy({ merchant: "Web Store", category: "Shopping", lat: null, lon: null }),
  ];

  it("offers the categories of purchases that have a place, the most first", () => {
    expect(placedCategories(all)).toEqual([
      { name: "Groceries", count: 2 },
      { name: "Dining", count: 1 },
      { name: UNCATEGORIZED, count: 1 },
    ]);
  });

  it("keeps only the chosen categories, or everything when none is chosen", () => {
    const names = (...picked: string[]) =>
      filterPurchases(all, { categories: new Set(picked) }).map((p) => p.merchant);
    expect(names("Groceries")).toEqual(["Grocer", "Grocer"]);
    expect(names(UNCATEGORIZED)).toEqual(["Stall"]);
    expect(names("Dining", UNCATEGORIZED)).toEqual(["Cafe", "Stall"]);
    expect(names()).toHaveLength(5);
    expect(filterPurchases(all, {})).toHaveLength(5);
  });
});
