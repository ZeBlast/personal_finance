import { eq, inArray, sql } from "drizzle-orm";
import { duplicateDismissals, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { notFound } from "../utils/errors.js";
import { getSettings } from "./settings.service.js";
import { getTransaction, type TransactionDto } from "./transaction.service.js";

/**
 * Two places to tidy up the data:
 *
 * Possible duplicates: two transactions on the same account for the same amount, a few days apart,
 * where one was entered by hand and the other came from the bank (the usual way a purchase gets in
 * twice), or both came from the bank on the same day with the same merchant. The user removes the
 * extra one or says they are not duplicates.
 *
 * The review queue: recent transactions worth a look, until the user marks them reviewed: ones with
 * no category, a merchant never seen before, an amount far above that merchant's usual, a large
 * amount, or a possible duplicate.
 */

const DUPLICATE_WINDOW_DAYS = 3;
const DUPLICATE_LOOKBACK_DAYS = 180;
export const REVIEW_WINDOW_DAYS = 60;
/** A purchase this large (in minor units) is always worth a look. */
const LARGE_MINOR = 50_000;

export type ReviewReason =
  "uncategorized" | "new_merchant" | "unusual_amount" | "large" | "duplicate";

const pairKey = (a: number, b: number): string => `${Math.min(a, b)}:${Math.max(a, b)}`;

const MERCHANT = sql`lower(coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name))`;

/** Pairs of transaction ids that may be the same transaction twice (smaller id first). */
export function duplicatePairs(db: AppDb, today: string): Array<[number, number]> {
  const environment = getSettings(db).plaidEnvironment;
  const since = addDays(today, -DUPLICATE_LOOKBACK_DAYS);
  const rows = db.all<{ a: number; b: number }>(sql`
    with t as (
      select t.*, ${MERCHANT} as merchant_key
      from transactions t
        join accounts acc on acc.id = t.account_id
        left join plaid_items p on p.id = acc.plaid_item_id
      where t.date >= ${since} and t.pending = 0 and t.amount_minor <> 0 and acc.hidden = 0
        and (p.environment = ${environment} or acc.plaid_item_id is null)
    )
    select x.id as a, y.id as b
    from t x join t y
      on x.account_id = y.account_id and x.amount_minor = y.amount_minor and x.id < y.id
      and abs(julianday(x.date) - julianday(y.date)) <= ${DUPLICATE_WINDOW_DAYS}
    where (x.source <> y.source)
      or (x.source = 'plaid' and y.source = 'plaid' and x.date = y.date
          and x.merchant_key = y.merchant_key)`);
  const dismissed = new Set(
    db
      .select({ key: duplicateDismissals.pairKey })
      .from(duplicateDismissals)
      .all()
      .map((r) => r.key),
  );
  return rows.filter((r) => !dismissed.has(pairKey(r.a, r.b))).map((r) => [r.a, r.b]);
}

export function listDuplicates(
  db: AppDb,
  today: string = new Date().toISOString().slice(0, 10),
): Array<{ key: string; transactions: [TransactionDto, TransactionDto] }> {
  return duplicatePairs(db, today).map(([a, b]) => ({
    key: pairKey(a, b),
    transactions: [getTransaction(db, a), getTransaction(db, b)],
  }));
}

/** "These two are not the same transaction." */
export function dismissDuplicate(
  db: AppDb,
  a: number,
  b: number,
  now = new Date().toISOString(),
): void {
  db.insert(duplicateDismissals)
    .values({ pairKey: pairKey(a, b), createdAt: now })
    .onConflictDoNothing()
    .run();
}

export interface ReviewItem {
  transaction: TransactionDto;
  reasons: ReviewReason[];
}

export interface ReviewQueue {
  items: ReviewItem[];
  counts: Record<ReviewReason, number>;
  windowDays: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export function reviewQueue(
  db: AppDb,
  today: string = new Date().toISOString().slice(0, 10),
): ReviewQueue {
  const environment = getSettings(db).plaidEnvironment;
  const since = addDays(today, -REVIEW_WINDOW_DAYS);
  const history = db.all<{
    id: number;
    date: string;
    amount: number;
    merchant: string;
    category_id: number | null;
    reviewed_at: string | null;
    is_transfer: number;
  }>(sql`
    select t.id as id, t.date as date, t.amount_minor as amount, ${MERCHANT} as merchant,
      t.category_id as category_id, t.reviewed_at as reviewed_at, t.is_transfer as is_transfer
    from transactions t
      join accounts acc on acc.id = t.account_id
      left join plaid_items p on p.id = acc.plaid_item_id
    where t.date >= ${addDays(since, -365)} and acc.hidden = 0 and acc.type <> 'investment'
      and (p.environment = ${environment} or acc.plaid_item_id is null)
    order by t.date, t.id`);

  const duplicates = new Set(duplicatePairs(db, today).flat());
  const byMerchant = new Map<string, Array<{ date: string; amount: number; id: number }>>();
  for (const h of history) {
    byMerchant.set(h.merchant, [...(byMerchant.get(h.merchant) ?? []), h]);
  }

  const counts: Record<ReviewReason, number> = {
    uncategorized: 0,
    new_merchant: 0,
    unusual_amount: 0,
    large: 0,
    duplicate: 0,
  };
  const flagged: Array<{ id: number; reasons: ReviewReason[] }> = [];
  for (const t of history) {
    if (t.date < since || t.reviewed_at !== null || t.is_transfer) continue;
    const reasons: ReviewReason[] = [];
    if (t.category_id === null) reasons.push("uncategorized");
    if (t.amount > 0) {
      const earlier = (byMerchant.get(t.merchant) ?? []).filter(
        (o) =>
          o.id !== t.id && o.amount > 0 && (o.date < t.date || (o.date === t.date && o.id < t.id)),
      );
      if (earlier.length === 0) reasons.push("new_merchant");
      else if (earlier.length >= 3) {
        const usual = median(earlier.map((o) => o.amount));
        if (t.amount >= usual * 3 && t.amount - usual >= 2_500) reasons.push("unusual_amount");
      }
      if (t.amount >= LARGE_MINOR) reasons.push("large");
    }
    if (duplicates.has(t.id)) reasons.push("duplicate");
    if (reasons.length === 0) continue;
    for (const r of reasons) counts[r] += 1;
    flagged.push({ id: t.id, reasons });
  }
  flagged.reverse(); // newest first
  return {
    items: flagged.map((f) => ({ transaction: getTransaction(db, f.id), reasons: f.reasons })),
    counts,
    windowDays: REVIEW_WINDOW_DAYS,
  };
}

/** Marks transactions as looked at (or not), taking them out of (or back into) the queue. */
export function setReviewed(
  db: AppDb,
  ids: number[],
  reviewed: boolean,
  now: string = new Date().toISOString(),
): number {
  if (ids.length === 0) return 0;
  const result = db
    .update(transactions)
    .set({ reviewedAt: reviewed ? now : null })
    .where(inArray(transactions.id, ids))
    .run();
  if (ids.length === 1 && result.changes === 0) throw notFound("That transaction");
  return result.changes;
}

export function isReviewed(db: AppDb, id: number): boolean {
  return (
    db
      .select({ at: transactions.reviewedAt })
      .from(transactions)
      .where(eq(transactions.id, id))
      .get()?.at != null
  );
}

/** At most this many uncategorized transactions are listed at once (the newest). */
export const UNCATEGORIZED_LIMIT = 300;

/**
 * Every transaction without a category, newest first, whenever it happened: transfers between the
 * user's own accounts and accounts left out (hidden, investments) are not listed, since they need
 * no category. `total` counts them all; `items` holds the newest UNCATEGORIZED_LIMIT.
 */
export function uncategorized(db: AppDb): { items: TransactionDto[]; total: number } {
  const environment = getSettings(db).plaidEnvironment;
  const ids = db.all<{ id: number }>(sql`
    select t.id from transactions t
      join accounts acc on acc.id = t.account_id
      left join plaid_items p on p.id = acc.plaid_item_id
    where t.category_id is null and t.is_transfer = 0 and t.amount_minor <> 0
      and acc.hidden = 0 and acc.type <> 'investment'
      and (p.environment = ${environment} or acc.plaid_item_id is null)
      and not exists (select 1 from transaction_splits s where s.transaction_id = t.id)
    order by coalesce(t.authorized_date, t.date) desc, t.id desc`);
  return {
    items: ids.slice(0, UNCATEGORIZED_LIMIT).map((r) => getTransaction(db, r.id)),
    total: ids.length,
  };
}
