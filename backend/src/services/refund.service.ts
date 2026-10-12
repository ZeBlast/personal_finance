import { eq, sql } from "drizzle-orm";
import { transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { namesAgree } from "./paypal-mirror.service.js";
import { getTransaction, type TransactionDto } from "./transaction.service.js";

/**
 * A refund linked to the charge it gives back. Totals then count the refund against that charge:
 * on the charge's date and in its category (see the transaction_lines view), and never as income,
 * so a returned purchase stops counting as spending. Several refunds may give back one charge,
 * but together never more than it.
 */

/** How long after a charge its refund may come. */
export const REFUND_WINDOW_DAYS = 180;

/** Detection only links a refund to a charge at most this many days before it. */
export const AUTO_REFUND_DAYS = 90;

/** Money between people, never a refund of a purchase however the names line up. */
const PERSON_TO_PERSON = /\b(zelle|venmo|cash ?app|apple cash)\b/i;

export interface RefundCandidate {
  id: number;
  /** Positive cents: what the refund gives back, or what the charge took. */
  amount: number;
  currency: string;
  /** Transaction date (authorized, else posted). */
  date: string;
  text: string;
  /** For a charge: it already has a refund linked. */
  refunded?: boolean;
}

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/**
 * Refunds that clearly give back one charge: the same amount and currency, the same merchant
 * (by name, see namesAgree), the charge up to AUTO_REFUND_DAYS days before the refund (or a day
 * after, as banks post them), and not money between people. A refund with no such charge, or
 * with several equally good ones, is left for the user. Each charge is used once. Returns
 * `[refund, charge]` pairs. Pure, for testing.
 */
export function matchRefunds(
  refunds: RefundCandidate[],
  charges: RefundCandidate[],
): Array<[number, number]> {
  const used = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const ordered = [...refunds].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const r of ordered) {
    if (PERSON_TO_PERSON.test(r.text)) continue;
    const fits = charges.filter((c) => {
      if (used.has(c.id) || c.refunded || c.amount !== r.amount || c.currency !== r.currency) {
        return false;
      }
      const gap = dayNumber(r.date) - dayNumber(c.date);
      return (
        gap >= -1 &&
        gap <= AUTO_REFUND_DAYS &&
        !PERSON_TO_PERSON.test(c.text) &&
        namesAgree(r.text, c.text)
      );
    });
    if (fits.length !== 1) continue;
    used.add(fits[0]!.id);
    pairs.push([r.id, fits[0]!.id]);
  }
  return pairs;
}

type Tx = Pick<AppDb, "all" | "run" | "update">;

/** Clears what detection linked last time, so it is worked out again. Part of detection. */
export function resetRefunds(tx: Tx): void {
  tx.run(sql`update transactions set refund_of_id = null, refund_source = null
    where refund_source = 'auto'`);
  // A link the user made whose charge is gone (removed by a sync) is dropped.
  tx.run(sql`update transactions set refund_of_id = null, refund_source = null
    where refund_of_id is not null
      and not exists (select 1 from transactions o where o.id = transactions.refund_of_id)`);
}

/**
 * Links refunds to the charges they give back where it is clear (see matchRefunds). Only rows
 * that count are looked at: a copy of a purchase shown on two accounts (PayPal and the card that
 * paid) is skipped, so a refund links to the charge that counts. Part of detection.
 */
export function detectRefunds(tx: Tx, now: string): number {
  const text = sql`coalesce(t.merchant_name_user, '') || ' ' || coalesce(t.merchant_name, '') || ' ' || t.name`;
  const counted = sql`t.is_transfer = 0 and t.pending = 0 and a.hidden = 0
    and a.type in ('credit', 'depository')`;
  const refunds = tx.all<{
    id: number;
    amount: number;
    currency: string;
    date: string;
    text: string;
  }>(sql`
    select t.id, -t.amount_minor as amount, t.currency, coalesce(t.authorized_date, t.date) as date,
      ${text} as text
    from transactions t join accounts a on a.id = t.account_id
      left join categories c on c.id = t.category_id
    where ${counted} and t.amount_minor < 0 and t.refund_of_id is null and t.refund_blocked = 0
      and coalesce(nullif(trim(t.sender_user), ''), nullif(trim(t.sender), '')) is null
      and coalesce(c.income_treatment, '') <> 'income'
      and coalesce(t.plaid_category_primary, '') <> 'INCOME'`);
  if (refunds.length === 0) return 0;
  const charges = tx.all<{
    id: number;
    amount: number;
    currency: string;
    date: string;
    text: string;
    refunded: number;
  }>(sql`
    select t.id, t.amount_minor as amount, t.currency, coalesce(t.authorized_date, t.date) as date,
      ${text} as text,
      exists (select 1 from transactions r where r.refund_of_id = t.id) as refunded
    from transactions t join accounts a on a.id = t.account_id
    where ${counted} and t.amount_minor > 0 and t.refund_of_id is null
      and coalesce(nullif(trim(t.recipient_user), ''), nullif(trim(t.recipient), '')) is null`);
  const pairs = matchRefunds(
    refunds,
    charges.map((c) => ({ ...c, refunded: c.refunded === 1 })),
  );
  for (const [refund, charge] of pairs) {
    tx.update(transactions)
      .set({ refundOfId: charge, refundSource: "auto", updatedAt: now })
      .where(eq(transactions.id, refund))
      .run();
  }
  return pairs.length;
}

function load(db: Pick<AppDb, "all">, id: number) {
  const row = db.all<{
    id: number;
    amount: number;
    currency: string;
    day: string;
    refund_of_id: number | null;
    transfer_pair_id: number | null;
    transfer_source: string | null;
    text: string;
  }>(sql`
    select id, amount_minor as amount, currency, coalesce(authorized_date, date) as day,
      refund_of_id, transfer_pair_id, transfer_source,
      coalesce(merchant_name_user, '') || ' ' || coalesce(merchant_name, '') || ' ' || name as text
    from transactions where id = ${id}`)[0];
  if (!row) throw notFound("That transaction");
  return row;
}

/** What has already been given back of a charge, apart from one refund (cents, positive). */
function refundedBy(db: Pick<AppDb, "all">, originalId: number, except: number): number {
  return (
    db.all<{ n: number | null }>(sql`
      select -sum(amount_minor) as n from transactions
      where refund_of_id = ${originalId} and id <> ${except}`)[0]?.n ?? 0
  );
}

/** Links a refund with the charge it gives back, or (originalId null) unlinks it. */
export function setRefundOf(
  db: AppDb,
  id: number,
  originalId: number | null,
  now = new Date().toISOString(),
): TransactionDto {
  const refund = load(db, id);
  if (originalId !== null) {
    if (refund.amount >= 0) {
      throw new AppError(400, "not_a_refund", "Only money coming back can be a refund.");
    }
    if (originalId === id) {
      throw new AppError(400, "same_transaction", "Choose the charge this gives back.");
    }
    const original = load(db, originalId);
    if (original.amount <= 0) {
      throw new AppError(400, "not_a_charge", "A refund gives back a charge: money that went out.");
    }
    if (original.refund_of_id !== null) {
      throw new AppError(400, "not_a_charge", "That transaction is itself a refund.");
    }
    if (original.currency !== refund.currency) {
      throw new AppError(409, "currency_mismatch", "The two use different currencies.");
    }
    if (original.day > addDays(refund.day, 3)) {
      throw new AppError(400, "refund_before_charge", "A refund can't come before its charge.");
    }
    if (refundedBy(db, originalId, id) - refund.amount > original.amount) {
      throw new AppError(
        409,
        "refunds_exceed_charge",
        "Together with the refunds already linked, this would give back more than was charged.",
      );
    }
    if (refund.transfer_pair_id !== null) {
      throw new AppError(
        409,
        "linked_transfer",
        "This is linked as a transfer between your accounts. Unlink that first.",
      );
    }
  }
  db.update(transactions)
    .set({
      refundOfId: originalId,
      // The user's choice: detection leaves it alone, and after "not a refund" never links it.
      refundSource: originalId === null ? null : "manual",
      refundBlocked: originalId === null,
      // A refund is spending given back, not money moved between the user's own accounts.
      ...(originalId !== null &&
      (refund.transfer_source === "auto" || refund.transfer_source === "category")
        ? { isTransfer: false, transferSource: "manual" }
        : {}),
      updatedAt: now,
    })
    .where(eq(transactions.id, id))
    .run();
  return getTransaction(db, id);
}

export interface RefundSuggestion {
  transaction: TransactionDto;
  namesAgree: boolean;
  /** The charge is exactly the refund's amount. */
  exactAmount: boolean;
  daysBefore: number;
}

/**
 * Charges a refund could give back: money that went out, in the same currency, from
 * REFUND_WINDOW_DAYS days before the refund until 3 days after, at least as much as the refund,
 * not itself a refund or a transfer. The same merchant first, then the exact amount, then the
 * closest date.
 */
export function refundCandidates(db: AppDb, id: number, limit = 10): RefundSuggestion[] {
  const refund = load(db, id);
  const amount = -refund.amount;
  const rows = db.all<{ id: number; amount: number; days: number; text: string }>(sql`
    select t.id, t.amount_minor as amount,
      julianday(${refund.day}) - julianday(coalesce(t.authorized_date, t.date)) as days,
      coalesce(t.merchant_name_user, '') || ' ' || coalesce(t.merchant_name, '') || ' ' || t.name
        as text
    from transactions t join accounts a on a.id = t.account_id
    where t.id <> ${id} and t.amount_minor >= ${amount} and t.currency = ${refund.currency}
      and t.refund_of_id is null and t.is_transfer = 0 and a.hidden = 0
      and coalesce(t.authorized_date, t.date)
        between ${addDays(refund.day, -REFUND_WINDOW_DAYS)} and ${addDays(refund.day, 3)}
    order by days limit 300`);
  return rows
    .map((r) => ({
      id: r.id,
      namesAgree: namesAgree(refund.text, r.text),
      exactAmount: r.amount === amount,
      daysBefore: Math.round(r.days),
    }))
    .sort(
      (x, y) =>
        Number(y.namesAgree) - Number(x.namesAgree) ||
        Number(y.exactAmount) - Number(x.exactAmount) ||
        Math.abs(x.daysBefore) - Math.abs(y.daysBefore) ||
        x.id - y.id,
    )
    .slice(0, limit)
    .map(({ id: chargeId, ...rest }) => ({ transaction: getTransaction(db, chargeId), ...rest }));
}
