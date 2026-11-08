import type { PlacePurchase } from "../types/places";

/**
 * The Places & rhythm page's arithmetic: purchases grouped into places, a week's rhythm (weekday by
 * hour), habits (shops visited often, and how their pace changed), and the filters that link them.
 * All pure.
 */

export interface Place {
  key: string;
  merchant: string;
  lat: number;
  lon: number;
  city: string | null;
  totalMinor: number;
  visits: number;
  /** The months visited (`YYYY-MM`), oldest first. */
  months: string[];
  firstDate: string;
  lastDate: string;
  /** Every visit's position is only a postal code's or city's (from an address lookup). */
  approx: boolean;
}

const DAY_MS = 86_400_000;
const dayMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);

/** One place per shop and spot (to about 100 m), biggest spending first. */
export function groupPlaces(purchases: PlacePurchase[]): Place[] {
  const byKey = new Map<string, Place>();
  for (const p of purchases) {
    if (p.lat === null || p.lon === null) continue;
    const key = `${p.merchant.trim().toLowerCase()}@${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    const place = byKey.get(key) ?? {
      key,
      merchant: p.merchant,
      lat: p.lat,
      lon: p.lon,
      city: p.city,
      totalMinor: 0,
      visits: 0,
      months: [],
      firstDate: p.date,
      lastDate: p.date,
      approx: true,
    };
    place.totalMinor += p.amountMinor;
    if (!p.approx) place.approx = false;
    place.visits += 1;
    const month = p.date.slice(0, 7);
    if (!place.months.includes(month)) place.months.push(month);
    if (p.date < place.firstDate) place.firstDate = p.date;
    if (p.date > place.lastDate) place.lastDate = p.date;
    byKey.set(key, place);
  }
  const places = [...byKey.values()];
  for (const p of places) p.months.sort();
  return places.sort((a, b) => b.totalMinor - a.totalMinor);
}

/** How fresh a place is: 1 when visited in the last month, fading to 0 a year after. */
export function recency(lastDate: string, today: string): number {
  const days = (dayMs(today) - dayMs(lastDate)) / DAY_MS;
  if (days <= 30) return 1;
  if (days >= 365) return 0;
  return 1 - (days - 30) / 335;
}

/** Monday is 0, Sunday 6. */
export function weekdayOf(date: string): number {
  return (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
}

/** The hour on this computer's clock, from the time the bank sent. */
export function localHour(datetime: string): number {
  return new Date(datetime).getHours();
}

export interface Rhythm {
  /** `cells[weekday][hour]`. */
  cells: Array<Array<{ count: number; totalMinor: number }>>;
  /** Purchases with no time of day, by weekday. */
  noTime: number[];
  maxCount: number;
}

export function rhythm(purchases: PlacePurchase[]): Rhythm {
  const cells = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ count: 0, totalMinor: 0 })),
  );
  const noTime = Array.from({ length: 7 }, () => 0);
  let maxCount = 0;
  for (const p of purchases) {
    const day = p.datetime ? weekdayOf(localDate(p.datetime)) : weekdayOf(p.date);
    if (p.datetime === null) {
      noTime[day]! += 1;
      continue;
    }
    const cell = cells[day]![localHour(p.datetime)]!;
    cell.count += 1;
    cell.totalMinor += p.amountMinor;
    maxCount = Math.max(maxCount, cell.count);
  }
  return { cells, noTime, maxCount };
}

/** The day on this computer's calendar for a time the bank sent. */
function localDate(datetime: string): string {
  const d = new Date(datetime);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface Habit {
  merchant: string;
  /** Each visit's day, oldest first. */
  dates: string[];
  visits: number;
  /** Average days between visits in the earlier half, and the later half. */
  gapEarlier: number;
  gapLater: number;
}

const average = (xs: number[]): number =>
  xs.length === 0 ? 0 : Math.round((xs.reduce((n, x) => n + x, 0) / xs.length) * 10) / 10;

/** Shops visited at least `minVisits` times, most visited first (at most `limit`). */
export function habits(purchases: PlacePurchase[], minVisits = 4, limit = 12): Habit[] {
  const byShop = new Map<string, { merchant: string; dates: string[] }>();
  for (const p of purchases) {
    const key = p.merchant.trim().toLowerCase();
    const shop = byShop.get(key) ?? { merchant: p.merchant, dates: [] };
    shop.dates.push(p.date);
    byShop.set(key, shop);
  }
  const out: Habit[] = [];
  for (const shop of byShop.values()) {
    if (shop.dates.length < minVisits) continue;
    const dates = [...shop.dates].sort();
    const gaps = dates.slice(1).map((d, i) => Math.round((dayMs(d) - dayMs(dates[i]!)) / DAY_MS));
    const half = Math.floor(gaps.length / 2);
    out.push({
      merchant: shop.merchant,
      dates,
      visits: dates.length,
      gapEarlier: average(gaps.slice(0, half)),
      gapLater: average(gaps.slice(half)),
    });
  }
  return out.sort((a, b) => b.visits - a.visits).slice(0, limit);
}

const every = (days: number): string => (days <= 1 ? "every day" : `every ${days} days`);

/** A habit's pace in words: steady, slowing or speeding up. */
export function paceText(h: Habit): string {
  const { gapEarlier: before, gapLater: after } = h;
  if (before === 0 || Math.abs(after - before) / before < 0.25) return every(after || before);
  return after > before
    ? `${every(before)}, slowing to every ${after}`
    : `${every(before)}, speeding up to every ${after}`;
}

export const cellKey = (weekday: number, hour: number): string => `${weekday}-${hour}`;

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Purchases in the chosen weekday-and-hour cells (any, when none are chosen) and inside the map's
 * view (any, without bounds; a purchase with no location is outside every view).
 */
export function filterPurchases(
  purchases: PlacePurchase[],
  f: {
    cells?: Set<string> | undefined;
    bounds?: Bounds | undefined;
    /** false leaves out purchases paid online. */
    online?: boolean | undefined;
  },
): PlacePurchase[] {
  return purchases.filter((p) => {
    if (f.online === false && p.online) return false;
    if (f.cells && f.cells.size > 0) {
      if (p.datetime === null) return false;
      const key = cellKey(weekdayOf(localDate(p.datetime)), localHour(p.datetime));
      if (!f.cells.has(key)) return false;
    }
    if (f.bounds) {
      if (p.lat === null || p.lon === null) return false;
      const b = f.bounds;
      if (p.lat < b.south || p.lat > b.north || p.lon < b.west || p.lon > b.east) return false;
    }
    return true;
  });
}

export const LIGHT_STYLE = "https://tiles.openfreemap.org/styles/liberty";
export const DARK_STYLE = "https://tiles.openfreemap.org/styles/dark";

/**
 * The map's look: OpenFreeMap's light or dark style when map images are on, or a plain light or
 * dark background when they are off. "auto" follows the app's (the system's) light or dark look.
 */
export function mapStyle(
  theme: "auto" | "light" | "dark",
  online: boolean,
  systemDark: boolean,
): { online: boolean; url: string | null; dark: boolean } {
  const dark = theme === "dark" || (theme === "auto" && systemDark);
  return { online, url: online ? (dark ? DARK_STYLE : LIGHT_STYLE) : null, dark };
}

/** The purchases with a position made in the `days` up to `end`: the ones a replay pings. */
export function beaconsAt(purchases: PlacePurchase[], end: string, days: number): PlacePurchase[] {
  const start = new Date(Date.parse(`${end}T12:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
  return purchases.filter(
    (p) => p.lat !== null && p.lon !== null && p.date > start && p.date <= end,
  );
}
