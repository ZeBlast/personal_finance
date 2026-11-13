/** Shapes returned by GET /api/places. */

export interface PlacePurchase {
  id: number;
  accountId: number;
  date: string;
  /** When the bank reports the time of day. */
  datetime: string | null;
  merchant: string;
  /** Positive. */
  amountMinor: number;
  category: string | null;
  lat: number | null;
  lon: number | null;
  /** Only the postal code's or the city's position, from an address lookup. */
  approx: boolean;
  /** Paid online rather than in a shop. */
  online: boolean;
  city: string | null;
  /** The address lookup that placed it (a Lookup's key), or null when the bank or the same store did. */
  lookupKey: string | null;
  /** The lookup that names its own shop or building, where a position set by hand is kept. */
  moveKey: string | null;
}

export type Precision = "address" | "street" | "shop" | "postcode" | "city";
export type Verdict = "right" | "wrong" | "moved";

/** One address lookup, for checking. GET /api/geocode/lookups answers with a list of them. */
export interface Lookup {
  key: string;
  /** The shop it was asked for, when it names one shop or building. */
  shop: string | null;
  /** What was asked, in words. */
  asked: string;
  /** The lookup server's own name for what it matched, or null when it found nothing. */
  found: string | null;
  precision: Precision;
  /** The server's answer, or the position set by hand; null when there is neither. */
  lat: number | null;
  lon: number | null;
  lookedUpAt: string | null;
  /** Purchases this lookup was made for. */
  purchases: number;
  /** Your call on it, or null when you have made none. */
  verdict: Verdict | null;
  /** It names one shop or building, so its position can be set by hand. */
  canMove: boolean;
}

export interface Lookups {
  lookups: Lookup[];
}

/** GET /api/geocode/status: address lookups for the map. */
export interface GeocodeStatus {
  enabled: boolean;
  server: string;
  running: boolean;
  total: number;
  done: number;
  found: number;
  notFound: number;
  /** Lookups waiting to be made. */
  pending: number;
  /** Purchases a lookup could still place. */
  unplaced: number;
  /** Lookups that gave a position (or have one set by hand), and how many are not checked yet. */
  lookups: number;
  unchecked: number;
  stopped: "cancelled" | "refused" | "failed" | "limit" | null;
  message: string | null;
  /** When every answer can next be cleared to look up again, or null when it can be now. */
  resetAvailableAt: string | null;
}

export interface Places {
  currency: string;
  from: string;
  to: string;
  counted: number;
  withPlace: number;
  withTime: number;
  purchases: PlacePurchase[];
}
