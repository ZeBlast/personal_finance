/** Shapes returned by GET /api/places. */

export interface PlacePurchase {
  id: number;
  date: string;
  /** When the bank reports the time of day. */
  datetime: string | null;
  merchant: string;
  /** Positive. */
  amountMinor: number;
  category: string | null;
  lat: number | null;
  lon: number | null;
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
  pending: number;
  stopped: "cancelled" | "refused" | "failed" | "limit" | null;
  message: string | null;
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
