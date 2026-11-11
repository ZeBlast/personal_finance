import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { fromTransactions, IS_INCOME, OWN_MERCHANT, whereClauses } from "./analytics.service.js";
import { resolveRows, type LocatedRow } from "./geocode.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Purchases with where and when they happened, for the Places & rhythm page: one row per purchase
 * (a split one counts once, whole), leaving out income, transfers and refunds, as the spending
 * reports do. The page groups them into places, a week rhythm and habits itself.
 */

export interface PlacePurchase {
  id: number;
  accountId: number;
  date: string;
  /** When the bank reports the time of day, as it sent it. */
  datetime: string | null;
  merchant: string;
  /** Positive. */
  amountMinor: number;
  category: string | null;
  lat: number | null;
  lon: number | null;
  /** The position is only the street's, the postal code's or the city's, found by an address lookup. */
  approx: boolean;
  /** Paid online (the bank's payment channel), as opposed to in a shop. */
  online: boolean;
  city: string | null;
}

export interface Places {
  currency: string;
  from: string;
  to: string;
  counted: number;
  /** How many have a location, and how many a time of day. */
  withPlace: number;
  withTime: number;
  purchases: PlacePurchase[];
}

const MAX_DAYS = 3 * 366;

interface Row extends LocatedRow {
  id: number;
  accountId: number;
  date: string;
  datetime: string | null;
  amount: number;
  category: string | null;
  lat: number | null;
  lon: number | null;
  channel: string | null;
}

export function placesData(db: AppDb, q: { from: string; to: string }): Places {
  if (!isRealDate(q.from) || !isRealDate(q.to) || q.from > q.to) {
    throw new AppError(400, "invalid_range", "Use real days, the start on or before the end.");
  }
  if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > MAX_DAYS) {
    throw new AppError(400, "range_too_long", "Choose a span of at most three years.");
  }
  const settings = getSettings(db);
  const where = whereClauses({
    from: q.from,
    to: q.to,
    includeTransfers: false,
    includePending: true,
    environment: settings.plaidEnvironment,
  });
  const rows = db.all<Row>(sql`
    select t.id as id, max(t.account_id) as accountId, max(t.date) as date, max(coalesce(t.datetime, t.authorized_datetime)) as datetime,
      max(${OWN_MERCHANT}) as merchant, sum(t.amount_minor) as amount, max(c.name) as category,
      max(t.location_lat) as lat, max(t.location_lon) as lon, max(t.location_city) as city,
      max(t.location_address) as address, max(t.location_region) as region,
      max(t.location_postal_code) as postalCode, max(t.location_country) as country,
      max(t.location_store_number) as store, max(t.original_description) as description,
      max(t.payment_channel) as channel
    ${fromTransactions}
    -- IS_INCOME is null (unknown) for a purchase with no bank category; null counts as not income.
    where ${where} and t.refund_of_id is null and coalesce(${IS_INCOME}, 0) = 0
    group by t.id
    having sum(t.amount_minor) > 0
    order by date, id
  `);
  // Purchases that came without coordinates: placed by the same store's known position, or by
  // the address lookups made so far.
  const { placed } = resolveRows(
    db,
    rows.filter((r) => r.lat === null || r.lon === null),
  );
  const purchases: PlacePurchase[] = rows.map((r) => {
    const found = r.lat !== null && r.lon !== null ? null : (placed.get(r) ?? null);
    return {
      id: r.id,
      accountId: r.accountId,
      date: r.date,
      datetime: r.datetime,
      merchant: r.merchant ?? "Unknown",
      amountMinor: r.amount,
      category: r.category,
      lat: r.lat ?? found?.lat ?? null,
      lon: r.lon ?? found?.lon ?? null,
      approx: found?.approx ?? false,
      online: r.channel === "online",
      city: r.city,
    };
  });
  return {
    currency: settings.currency,
    from: q.from,
    to: q.to,
    counted: purchases.length,
    withPlace: purchases.filter((p) => p.lat !== null && p.lon !== null).length,
    withTime: purchases.filter((p) => p.datetime !== null).length,
    purchases,
  };
}
