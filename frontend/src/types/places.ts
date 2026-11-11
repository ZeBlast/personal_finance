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
