import { eq, inArray, sql } from "drizzle-orm";
import { transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { STORE_CREDIT_SUBTYPE } from "./account-scope.js";
import { detectMirrors, resetMirrors } from "./paypal-mirror.service.js";
import { detectRefunds, resetRefunds } from "./refund.service.js";

/**
 * Transfers between the user's own accounts.
 *
 * Moving money from checking to savings is neither income nor spending, so it must not count in
 * either. Paying or receiving money from another person (a Zelle to a friend, rent to a landlord)
 * is both of those things, and does count. The difference is who is on the other side, which the
 * bank's description cannot say reliably, so this finds it by matching: an outgoing transaction on
 * one of the user's accounts and an incoming one of exactly the same amount on another of their
 * accounts, a few days apart, where at least one of them reads like a transfer or a payment.
 *
 * The user always has the last word. A flag they set by hand (`transfer_source = 'manual'`) is
 * never changed here, and one the app set (`auto`) goes away when its match does (for example when
 * the other side is deleted), because every run starts by clearing the automatic flags. A flag from
 * a category (`category`, see syncCategoryTransfers) is cleared too, so such a transaction can still
 * be matched with its other side; only if it finds none is the category's flag put back.
 */

/** How many days apart the two sides of a transfer can post. */
export const MATCH_WINDOW_DAYS = 4;

/**
 * How far apart a card payment and the money that paid it can be. Banks often post a card payment
 * days before the paying account shows the money leaving (or after), so this is wider.
 */
export const CARD_PAYMENT_WINDOW_DAYS = 10;

/**
 * Credits on a card that are not payments: promotions, cashback and rewards redemptions, refunds,
 * and adjustments. These are never matched with money from another account.
 */
const NOT_A_PAYMENT =
  /\b(cash ?back|rewards?|redemption|refund|return|promo(tion)?|statement credit|adjustment|bonus|dispute|benefit|claim|protection)\b|credit thank you/i;
const PAYMENT_WORDS = /\b(payment|pymt|pmt|autopay|auto pay|thank you|epay|online pmt|bill pay)\b/i;

/** Whether money coming into a credit card or loan is a payment toward it (not a credit or refund). */
export function isCardPayment(c: { category: string | null; name: string }): boolean {
  if (NOT_A_PAYMENT.test(c.name)) return false;
  // Plaid files benefit payouts and the like as income: money given, not a payment made.
  if ((c.category ?? "").startsWith("INCOME")) return false;
  const category = c.category ?? "";
  return (
    category.startsWith("LOAN_PAYMENTS") || category === "TRANSFER_IN" || PAYMENT_WORDS.test(c.name)
  );
}

/**
 * Pairs each payment into a credit card or loan with the money that left another of the user's
 * accounts to pay it: the same amount, within CARD_PAYMENT_WINDOW_DAYS days either way, preferring
 * one that reads like a payment and then the closest in time. Pure, for testing.
 */
export function matchCardPayments(
  payments: Candidate[],
  funding: Candidate[],
): Array<[number, number]> {
  const used = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const ordered = [...payments].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const pay of ordered) {
    let best: Candidate | null = null;
    let bestScore = Infinity;
    for (const out of funding) {
      if (used.has(out.id) || out.accountId === pay.accountId) continue;
      if (out.currency !== pay.currency || out.amount !== -pay.amount) continue;
      const gap = Math.abs(dayNumber(out.date) - dayNumber(pay.date));
      if (gap > CARD_PAYMENT_WINDOW_DAYS) continue;
      // Reading like a payment counts for more than a few days' difference.
      const score = gap + (readsLikeTransfer(out) ? 0 : 100);
      if (score < bestScore || (score === bestScore && best !== null && out.id < best.id)) {
        best = out;
        bestScore = score;
      }
    }
    if (best) {
      used.add(best.id);
      pairs.push([best.id, pay.id]);
    }
  }
  return pairs;
}

const CATEGORY = /^(TRANSFER_|LOAN_PAYMENTS)/;
// "mobile" only as banking: alone it matches "T-Mobile", whose bill and refund could pair up.
const WORDS =
  /\b(transfer|xfer|trnsfr|payment|pmt|zelle|ach|funds|online banking|mobile (banking|transfer|xfer))\b/i;

interface Candidate {
  id: number;
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  category: string | null;
  name: string;
}

const readsLikeTransfer = (c: Candidate): boolean =>
  (c.category !== null && CATEGORY.test(c.category)) || WORDS.test(c.name);

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** Pairs up outgoing and incoming candidates. Pure, so it can be tested without a database. */
export function matchTransfers(candidates: Candidate[]): Array<[number, number]> {
  const outgoing = candidates
    .filter((c) => c.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const incoming = candidates.filter((c) => c.amount < 0);
  const used = new Set<number>();
  const pairs: Array<[number, number]> = [];

  for (const out of outgoing) {
    let best: Candidate | null = null;
    let bestGap = Infinity;
    for (const inn of incoming) {
      if (used.has(inn.id) || inn.accountId === out.accountId) continue;
      if (inn.currency !== out.currency || -inn.amount !== out.amount) continue;
      const gap = Math.abs(dayNumber(inn.date) - dayNumber(out.date));
      if (gap > MATCH_WINDOW_DAYS) continue;
      // An exact amount on a different account is not enough on its own (a refund can equal a
      // purchase): one side must read like a transfer or a payment.
      if (!readsLikeTransfer(out) && !readsLikeTransfer(inn)) continue;
      if (gap < bestGap || (gap === bestGap && best !== null && inn.id < best.id)) {
        best = inn;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.id);
      pairs.push([out.id, best.id]);
    }
  }
  return pairs;
}

/**
 * Finds transfers between the user's own accounts and flags both sides. Safe to run any time and as
 * often as wanted. Returns how many pairs are currently matched.
 */
export function detectInternalTransfers(db: AppDb, now: string = new Date().toISOString()): number {
  return db.transaction((tx) => {
    // Start from a clean slate for what the app decided (matches, and flags from a category);
    // keep what the user and the system decided.
    tx.update(transactions)
      .set({ isTransfer: false, transferSource: null, transferPairId: null })
      .where(inArray(transactions.transferSource, ["auto", "category"]))
      .run();
    // A link the user made whose other side is gone (removed by a sync, or its account deleted)
    // stays a transfer, just no longer linked, so it shows up as one-sided rather than pointing
    // at nothing.
    tx.run(sql`update transactions set transfer_pair_id = null
      where transfer_source = 'manual' and transfer_pair_id is not null
        and not exists (select 1 from transactions p
          where p.id = transactions.transfer_pair_id and p.transfer_pair_id = transactions.id)`);
    // Copies of one purchase on two accounts (PayPal and the card that paid) are found again
    // after transfers, from what is left.
    resetMirrors(tx, now);
    // Refunds linked by the app are worked out again at the end, once copies are known.
    resetRefunds(tx);

    const rows = tx.all<{
      id: number;
      account_id: number;
      date: string;
      amount_minor: number;
      currency: string;
      category: string | null;
      name: string;
      account_type: string;
      transaction_date: string;
    }>(sql`
      select t.id, t.account_id, t.date, t.amount_minor, t.currency,
        t.plaid_category_primary as category,
        coalesce(t.plaid_category_detailed, '') || ' ' || t.name as name,
        a.type as account_type, coalesce(t.authorized_date, t.date) as transaction_date
      from transactions t join accounts a on a.id = t.account_id
      where t.transfer_source is null and t.amount_minor <> 0 and t.refund_of_id is null
        and coalesce(a.subtype, '') <> ${STORE_CREDIT_SUBTYPE}`);
    const toCandidate = (r: (typeof rows)[number], useTransactionDate = false): Candidate => ({
      id: r.id,
      accountId: r.account_id,
      date: useTransactionDate ? r.transaction_date : r.date,
      amount: r.amount_minor,
      currency: r.currency,
      category: r.category,
      name: r.name,
    });

    // First, every payment into a card or loan, with the money that paid it.
    const debt = (r: (typeof rows)[number]) =>
      r.account_type === "credit" || r.account_type === "loan";
    const cardPairs = matchCardPayments(
      rows
        .filter((r) => debt(r) && r.amount_minor < 0 && isCardPayment(toCandidate(r)))
        .map((r) => toCandidate(r)),
      rows.filter((r) => !debt(r) && r.amount_minor > 0).map((r) => toCandidate(r, true)),
    );
    const paired = new Set(cardPairs.flat());

    // Then any other move between the user's own accounts.
    // Money coming into a card or loan that is not a payment (a promotion, cashback, a refund) is
    // never the other side of a transfer.
    const candidates = rows
      .filter((r) => !paired.has(r.id))
      .filter((r) => !(debt(r) && r.amount_minor < 0 && !isCardPayment(toCandidate(r))))
      .map((r) => toCandidate(r));
    const pairs = [...cardPairs, ...matchTransfers(candidates)];
    for (const [a, b] of pairs) {
      for (const [id, other] of [
        [a, b],
        [b, a],
      ] as const) {
        tx.update(transactions)
          .set({ isTransfer: true, transferSource: "auto", transferPairId: other, updatedAt: now })
          .where(eq(transactions.id, id))
          .run();
      }
    }
    // What found no match, but sits in a category that moves the user's own money, is a transfer.
    syncCategoryTransfers(tx, now);
    detectMirrors(tx, now);
    detectRefunds(tx, now);
    return pairs.length;
  });
}

/**
 * Keeps the transfer flag in line with categories that move the user's own money (a cash
 * withdrawal, savings and investing: `income_treatment = 'transfer'`). A transaction in one is
 * flagged (`transfer_source = 'category'`), so it counts as neither income nor spending anywhere;
 * one moved out of such a category loses that flag. A match between two accounts, or the user's own
 * choice, always wins.
 */
export function syncCategoryTransfers(
  db: Pick<AppDb, "update">,
  now: string = new Date().toISOString(),
): void {
  const moving = sql`(select id from categories where income_treatment = 'transfer')`;
  db.update(transactions)
    .set({ isTransfer: true, transferSource: "category", transferPairId: null, updatedAt: now })
    .where(sql`${transactions.transferSource} is null and ${transactions.categoryId} in ${moving}`)
    .run();
  db.update(transactions)
    .set({ isTransfer: false, transferSource: null, updatedAt: now })
    .where(
      sql`${transactions.transferSource} = 'category'
        and (${transactions.categoryId} is null or ${transactions.categoryId} not in ${moving})`,
    )
    .run();
}

/**
 * The user's decision about one transaction: `true` (a transfer between my own accounts), `false`
 * (not a transfer, whatever the app thinks), or `null` (let the app decide again). If the
 * transaction was matched with another, that one is released to be matched afresh.
 */
export function setTransferFlag(
  db: AppDb,
  id: number,
  value: boolean | null,
  now: string = new Date().toISOString(),
): void {
  const row = db
    .select({
      source: transactions.transferSource,
      pairId: transactions.transferPairId,
    })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!row) throw notFound("That transaction");
  if (row.source === "mirror") {
    throw new AppError(
      409,
      "mirror_linked",
      "This is a copy of a purchase another account shows. Unlink it first.",
    );
  }
  if (row.source === "manual" && row.pairId !== null) {
    // Already a transfer the user linked: saying so again keeps the link.
    if (value === true) return;
    throw new AppError(
      409,
      "linked_transfer",
      "This transfer is linked with a transaction on another account. Unlink it first.",
    );
  }

  db.transaction((tx) => {
    if (row.source === "auto" && row.pairId !== null) {
      // Saying yes to a match confirms it: both sides become the user's decision, still paired.
      if (value === true) {
        tx.update(transactions)
          .set({ transferSource: "manual", updatedAt: now })
          .where(inArray(transactions.id, [id, row.pairId]))
          .run();
        return;
      }
      // Otherwise the partner loses its flag; detection below may match it with something else.
      tx.update(transactions)
        .set({ isTransfer: false, transferSource: null, transferPairId: null })
        .where(eq(transactions.id, row.pairId))
        .run();
    }
    tx.update(transactions)
      .set(
        value === null
          ? { isTransfer: false, transferSource: null, transferPairId: null, updatedAt: now }
          : { isTransfer: value, transferSource: "manual", transferPairId: null, updatedAt: now },
      )
      .where(eq(transactions.id, id))
      .run();
  });
  detectInternalTransfers(db, now);
}
