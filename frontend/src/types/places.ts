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

export interface Places {
  currency: string;
  from: string;
  to: string;
  counted: number;
  withPlace: number;
  withTime: number;
  purchases: PlacePurchase[];
}
