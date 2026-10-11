import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { STORE_CREDIT_SUBTYPE } from "./account-scope.js";
import { getTransaction, type TransactionDto } from "./transaction.service.js";
import { detectInternalTransfers } from "./transfer.service.js";

/**
 * One purchase that two of the user's accounts both show. Paying with PayPal using a card puts the
 * purchase on PayPal ("Payment to Whatnot") and the charge on the card ("WHATNOT INC"), so it
 * would count twice. The two are linked: one counts, the other is marked a copy
 * (`transfer_source = 'mirror'`, `mirror_of_id` = the one that counts) and is left out of income
 * and spending like a transfer. The card or bank row counts, being where the money left, unless
 * its description only says PayPal ("PAYPAL DES:INST XFER"), in which case the PayPal row, which
 * names the merchant, counts instead.
 *
 * Detection links what clearly belongs together (see matchMirrors); the user can link others,
 * or unlink a wrong one, which also stops detection linking either row again.
 */

/** How many days after the PayPal purchase the paying card or bank shows it (or a day before). */
export const MIRROR_DAYS_AFTER = 4;
export const MIRROR_DAYS_BEFORE = 1;

/** An account PayPal holds: by the connection's institution, or the account's subtype or name. */
export const IS_PAYPAL_ACCOUNT = sql`(lower(coalesce(pi.institution_name, '')) like '%paypal%'
  or lower(coalesce(a.subtype, '')) = 'paypal' or lower(a.name) like '%paypal%')`;

export interface MirrorCandidate {
  id: number;
  accountId: number;
  /** The transaction date (authorized, else posted). */
  date: string;
  /** Plaid's sign: positive when money leaves the account. */
  amount: number;
  currency: string;
  /** Merchant and description together, for comparing names. */
  text: string;
}

const READS_PAYPAL = /\b(paypal|pypl)\b/i;
const NOISE = new Set([
  "payment",
  "from",
  "inc",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "com",
  "www",
  "paypal",
  "pypl",
  "des",
  "the",
  "purchase",
  "transfer",
  "xfer",
  "inst",
  "pos",
  "debit",
  "card",
  "online",
  "and",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !NOISE.has(w));
}

/** Whether two descriptions name the same merchant: a shared word, or one word starting another. */
export function namesAgree(a: string, b: string): boolean {
  const theirs = words(b);
  return words(a).some((w) =>
    theirs.some(
      (v) => w === v || (Math.min(w.length, v.length) >= 4 && (w.startsWith(v) || v.startsWith(w))),
    ),
  );
}

/** Whether a card or bank row only says PayPal, not the merchant. */
export const readsPaypal = (c: Pick<MirrorCandidate, "text">): boolean => READS_PAYPAL.test(c.text);

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/**
 * Pairs PayPal purchases with the card or bank charges that paid them: money leaving both, the same
 * amount and currency, the charge from MIRROR_DAYS_BEFORE days before to MIRROR_DAYS_AFTER days
 * after, and either the same merchant name or a charge that says PayPal. Each row is used once;
 * the best match is one that names the merchant, then the closest date. Returns
 * `{ copy, counts }` per pair. Pure, for testing.
 */
export function matchMirrors(
  paypal: MirrorCandidate[],
  others: MirrorCandidate[],
): Array<{ copy: number; counts: number }> {
  const used = new Set<number>();
  const pairs: Array<{ copy: number; counts: number }> = [];
  const ordered = [...paypal].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const p of ordered) {
    if (p.amount <= 0) continue;
    let best: MirrorCandidate | null = null;
    let bestScore = Infinity;
    for (const o of others) {
      if (used.has(o.id) || o.accountId === p.accountId) continue;
      if (o.currency !== p.currency || o.amount !== p.amount) continue;
      const gap = dayNumber(o.date) - dayNumber(p.date);
      if (gap < -MIRROR_DAYS_BEFORE || gap > MIRROR_DAYS_AFTER) continue;
      const named = namesAgree(p.text, o.text);
      if (!named && !readsPaypal(o)) continue;
      const score = Math.abs(gap) + (named ? 0 : 100);
      if (score < bestScore || (score === bestScore && best !== null && o.id < best.id)) {
        best = o;
        bestScore = score;
      }
    }
    if (best) {
      used.add(best.id);
      pairs.push(
        readsPaypal(best) ? { copy: best.id, counts: p.id } : { copy: p.id, counts: best.id },
      );
    }
  }
  return pairs;
}

type Tx = Pick<AppDb, "select" | "update" | "all" | "run">;

/** Turns a copy back into an ordinary transaction (it counts again). */
function restore(tx: Pick<AppDb, "update">, ids: number[], now: string, blocked?: boolean) {
  if (ids.length === 0) return;
  tx.update(transactions)
    .set({
      isTransfer: false,
      transferSource: null,
      mirrorOfId: null,
      mirrorSource: null,
      updatedAt: now,
      ...(blocked === undefined ? {} : { mirrorBlocked: blocked }),
    })
    .where(inArray(transactions.id, ids))
    .run();
}

function markCopy(
  tx: Pick<AppDb, "update">,
  copy: number,
  counts: number,
  source: string,
  now: string,
) {
  tx.update(transactions)
    .set({
      isTransfer: true,
      transferSource: "mirror",
      transferPairId: null,
      mirrorOfId: counts,
      mirrorSource: source,
      updatedAt: now,
    })
    .where(eq(transactions.id, copy))
    .run();
}

/**
 * Clears what detection linked last time, and links the user made whose other side is gone, before
 * transfers are matched, so those rows are looked at afresh. Part of detectInternalTransfers.
 */
export function resetMirrors(tx: Tx, now: string): void {
  tx.update(transactions)
    .set({ isTransfer: false, transferSource: null, mirrorOfId: null, mirrorSource: null })
    .where(eq(transactions.mirrorSource, "auto"))
    .run();
  const dangling = tx
    .all<{ id: number }>(
      sql`select id from transactions
      where mirror_source = 'manual'
        and not exists (select 1 from transactions c where c.id = transactions.mirror_of_id)`,
    )
    .map((r) => r.id);
  restore(tx, dangling, now);
}

/** Links PayPal purchases with the charges that paid them (see matchMirrors). Part of detection. */
export function detectMirrors(tx: Tx, now: string): number {
  const rows = tx.all<{
    id: number;
    account_id: number;
    date: string;
    amount_minor: number;
    currency: string;
    text: string;
    is_paypal: number;
  }>(sql`
    select t.id, t.account_id, coalesce(t.authorized_date, t.date) as date, t.amount_minor,
      t.currency, ${IS_PAYPAL_ACCOUNT} as is_paypal,
      coalesce(t.merchant_name_user, '') || ' ' || coalesce(t.merchant_name, '') || ' ' || t.name
        as text
    from transactions t join accounts a on a.id = t.account_id
      left join plaid_items pi on pi.id = a.plaid_item_id
    where t.transfer_source is null and t.mirror_blocked = 0 and t.pending = 0
      and t.amount_minor > 0 and t.created_for_transfer = 0
      and a.type in ('credit', 'depository') and coalesce(a.subtype, '') <> ${STORE_CREDIT_SUBTYPE}
      and not exists (select 1 from transactions c where c.mirror_of_id = t.id)`);
  const toCandidate = (r: (typeof rows)[number]): MirrorCandidate => ({
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    amount: r.amount_minor,
    currency: r.currency,
    text: r.text,
  });
  const pairs = matchMirrors(
    rows.filter((r) => r.is_paypal === 1).map(toCandidate),
    rows.filter((r) => r.is_paypal === 0).map(toCandidate),
  );
  for (const { copy, counts } of pairs) markCopy(tx, copy, counts, "auto", now);
  return pairs.length;
}

function load(db: Pick<AppDb, "all">, id: number) {
  const row = db.all<{
    id: number;
    account_id: number;
    amount_minor: number;
    currency: string;
    transfer_pair_id: number | null;
    created_for_transfer: number;
    mirror_of_id: number | null;
    is_paypal: number;
    text: string;
  }>(sql`
    select t.id, t.account_id, t.amount_minor, t.currency, t.transfer_pair_id,
      t.created_for_transfer, t.mirror_of_id, ${IS_PAYPAL_ACCOUNT} as is_paypal,
      coalesce(t.merchant_name_user, '') || ' ' || coalesce(t.merchant_name, '') || ' ' || t.name
        as text
    from transactions t join accounts a on a.id = t.account_id
      left join plaid_items pi on pi.id = a.plaid_item_id
    where t.id = ${id}`)[0];
  if (!row) throw notFound("That transaction");
  return row;
}

/** Copies linked with either of these rows, as copy or as the row that counts. */
function linkedCopies(db: Pick<AppDb, "select">, ids: number[]): number[] {
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      or(
        inArray(transactions.mirrorOfId, ids),
        and(inArray(transactions.id, ids), isNotNull(transactions.mirrorOfId)),
      ),
    )
    .all()
    .map((r) => r.id);
}

/**
 * Links two transactions as one purchase shown on two accounts, by the user's choice. Which one
 * counts follows the same rule as detection; between two accounts that are not PayPal, the given
 * transaction becomes the copy of the other. Replaces any such link either had.
 */
export function linkMirror(
  db: AppDb,
  id: number,
  otherId: number,
  now = new Date().toISOString(),
): TransactionDto {
  if (id === otherId)
    throw new AppError(400, "same_transaction", "Choose a different transaction.");
  const a = load(db, id);
  const b = load(db, otherId);
  if (a.account_id === b.account_id) {
    throw new AppError(400, "same_account", "Choose a transaction on a different account.");
  }
  if (a.currency !== b.currency) {
    throw new AppError(409, "currency_mismatch", "The two transactions use different currencies.");
  }
  if (a.amount_minor === 0 || a.amount_minor > 0 !== b.amount_minor > 0) {
    throw new AppError(
      400,
      "different_direction",
      "Both must be the same purchase, so money must go the same way on both.",
    );
  }
  for (const t of [a, b]) {
    if (t.transfer_pair_id !== null || t.created_for_transfer === 1) {
      throw new AppError(
        409,
        "linked_transfer",
        "One of these is linked as a transfer. Unlink that first.",
      );
    }
  }
  // A PayPal row with a card or bank row: the same rule as detection. Otherwise this one is the copy.
  const [paypal, other] =
    a.is_paypal === b.is_paypal ? [null, null] : a.is_paypal === 1 ? [a, b] : [b, a];
  const [copy, counts] =
    paypal && other ? (readsPaypal(other) ? [other, paypal] : [paypal, other]) : [a, b];
  db.transaction((tx) => {
    restore(tx, linkedCopies(tx, [a.id, b.id]), now);
    markCopy(tx, copy.id, counts.id, "manual", now);
    tx.update(transactions)
      .set({ mirrorBlocked: false, updatedAt: now })
      .where(inArray(transactions.id, [a.id, b.id]))
      .run();
  });
  detectInternalTransfers(db, now);
  return getTransaction(db, id);
}

/**
 * Undoes a link between a copy and the transaction that counts (either can be given): both count
 * again, and detection never links either as a copy again.
 */
export function unlinkMirror(
  db: AppDb,
  id: number,
  now = new Date().toISOString(),
): TransactionDto {
  const t = load(db, id);
  const copies = linkedCopies(db, [id]);
  if (copies.length === 0) {
    throw new AppError(409, "not_linked", "This transaction is not linked with a copy.");
  }
  const partners = t.mirror_of_id !== null ? [t.mirror_of_id] : copies;
  db.transaction((tx) => {
    restore(tx, copies, now, true);
    tx.update(transactions)
      .set({ mirrorBlocked: true, updatedAt: now })
      .where(inArray(transactions.id, [id, ...partners]))
      .run();
  });
  detectInternalTransfers(db, now);
  return getTransaction(db, id);
}

/** How far apart, in days, a suggested other copy of a purchase can be. */
export const MIRROR_CANDIDATE_DAYS = 7;

export interface MirrorSuggestion {
  transaction: TransactionDto;
  exactAmount: boolean;
  namesAgree: boolean;
  daysApart: number;
}

/**
 * Transactions that could be the same purchase shown on another account: the same direction and
 * currency, within MIRROR_CANDIDATE_DAYS days, not linked as a transfer. The exact amount comes
 * first, then a matching merchant name, then the closest date.
 */
export function mirrorCandidates(db: AppDb, id: number, limit = 10): MirrorSuggestion[] {
  const t = load(db, id);
  const day = db.all<{ day: string }>(
    sql`select coalesce(authorized_date, date) as day from transactions where id = ${id}`,
  )[0]!.day;
  const rows = db.all<{ id: number; exact: number; days: number; text: string }>(sql`
    select c.id, (c.amount_minor = ${t.amount_minor}) as exact,
      abs(julianday(coalesce(c.authorized_date, c.date)) - julianday(${day})) as days,
      coalesce(c.merchant_name_user, '') || ' ' || coalesce(c.merchant_name, '') || ' ' || c.name
        as text
    from transactions c join accounts a on a.id = c.account_id
    where c.account_id <> ${t.account_id} and c.id <> ${id} and c.currency = ${t.currency}
      and c.created_for_transfer = 0 and c.transfer_pair_id is null and a.hidden = 0
      and coalesce(a.subtype, '') <> ${STORE_CREDIT_SUBTYPE}
      and (c.amount_minor > 0) = ${t.amount_minor > 0 ? 1 : 0} and c.amount_minor <> 0
      and abs(julianday(coalesce(c.authorized_date, c.date)) - julianday(${day}))
        <= ${MIRROR_CANDIDATE_DAYS}
    order by exact desc, abs(c.amount_minor - ${t.amount_minor}), days, c.id
    limit ${limit * 3}`);
  return rows
    .map((r) => ({
      id: r.id,
      exactAmount: r.exact === 1,
      namesAgree: namesAgree(t.text, r.text),
      daysApart: Math.round(r.days),
    }))
    .sort(
      (x, y) =>
        Number(y.exactAmount) - Number(x.exactAmount) ||
        Number(y.namesAgree) - Number(x.namesAgree) ||
        x.daysApart - y.daysApart ||
        x.id - y.id,
    )
    .slice(0, limit)
    .map(({ id: otherId, ...rest }) => ({ transaction: getTransaction(db, otherId), ...rest }));
}

/**
 * The first day any connected card or bank account other than PayPal has a transaction. A PayPal
 * transaction before it cannot be matched with what paid for it: no other history goes back that
 * far. Null when there is no such account yet.
 */
export function otherHistoryStart(db: Pick<AppDb, "all">): string | null {
  return (
    db.all<{ day: string | null }>(sql`
      select min(coalesce(t.authorized_date, t.date)) as day
      from transactions t join accounts a on a.id = t.account_id
        join plaid_items pi on pi.id = a.plaid_item_id
      where a.type in ('credit', 'depository') and a.hidden = 0 and not ${IS_PAYPAL_ACCOUNT}`)[0]
      ?.day ?? null
  );
}
