import { eq, sql } from "drizzle-orm";
import { instalmentPurchases, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { getTransaction, type TransactionDto } from "./transaction.service.js";

/**
 * A purchase paid off in instalments (Pay in 4, Klarna, Afterpay). The purchase counts once, on
 * its own date; the repayments that pay it off are linked to it and leave every total, as
 * transfers do (`is_transfer = 1`, `transfer_source = 'instalment'`). Together they may not come
 * to more than the purchase: a fee or interest charge is left unlinked, so it still counts as
 * spending. Unlinking puts a repayment back exactly as it was.
 */

export const MIN_INSTALMENTS = 2;
export const MAX_INSTALMENTS = 24;

/** How long after a purchase its repayments are looked for. */
const WINDOW_DAYS = 180;
/** How far a repayment may be from the purchase divided by the instalments (cents). */
const AMOUNT_SLACK = 100;
const MAX_CANDIDATES = 20;
const INSTALMENT_WORDS = /\b(pay in 4|afterpay|klarna|affirm|sezzle|zip|paypal)\b/i;

type Tx = Pick<AppDb, "all" | "run" | "update" | "select" | "delete" | "insert">;

function load(db: Pick<AppDb, "all">, id: number) {
  const row = db.all<{
    id: number;
    amount: number;
    currency: string;
    day: string;
    is_transfer: number;
    pending: number;
    transfer_source: string | null;
    transfer_pair_id: number | null;
    mirror_of_id: number | null;
    refund_of_id: number | null;
    instalment_of_id: number | null;
    prior_transfer: number | null;
    prior_source: string | null;
    splits: number;
  }>(sql`
    select id, amount_minor as amount, currency, coalesce(authorized_date, date) as day,
      is_transfer, pending, transfer_source, transfer_pair_id, mirror_of_id, refund_of_id,
      instalment_of_id, instalment_prior_transfer as prior_transfer,
      instalment_prior_source as prior_source,
      (select count(*) from transaction_splits s where s.transaction_id = transactions.id) as splits
    from transactions where id = ${id}`)[0];
  if (!row) throw notFound("That transaction");
  return row;
}

function plan(db: Pick<AppDb, "all">, purchaseId: number) {
  return db.all<{ instalments: number }>(
    sql`select instalments from instalment_purchases where transaction_id = ${purchaseId}`,
  )[0];
}

/** Cents of the purchase paid back by linked repayments, apart from one. */
function paidBy(db: Pick<AppDb, "all">, purchaseId: number, except: number): number {
  return (
    db.all<{ n: number | null }>(sql`
      select sum(amount_minor) as n from transactions
      where instalment_of_id = ${purchaseId} and id <> ${except}`)[0]?.n ?? 0
  );
}

/** Puts a repayment back as it was before it was linked. */
function restore(
  tx: Pick<AppDb, "update">,
  id: number,
  prior: ReturnType<typeof load>,
  now: string,
) {
  tx.update(transactions)
    .set({
      isTransfer: prior.prior_transfer === 1,
      transferSource: prior.prior_source,
      instalmentOfId: null,
      instalmentPriorTransfer: null,
      instalmentPriorSource: null,
      updatedAt: now,
    })
    .where(eq(transactions.id, id))
    .run();
}

/** Marks a purchase as paid in instalments (or changes how many). */
export function markInstalments(
  db: AppDb,
  purchaseId: number,
  instalments: number,
  now = new Date().toISOString(),
): TransactionDto {
  if (
    !Number.isInteger(instalments) ||
    instalments < MIN_INSTALMENTS ||
    instalments > MAX_INSTALMENTS
  ) {
    throw new AppError(
      400,
      "invalid_instalments",
      `Choose between ${MIN_INSTALMENTS} and ${MAX_INSTALMENTS} instalments.`,
    );
  }
  const p = load(db, purchaseId);
  if (p.amount <= 0 || p.refund_of_id !== null) {
    throw new AppError(
      400,
      "not_a_purchase",
      "Only a purchase (money that went out) can be paid in instalments.",
    );
  }
  if (p.pending === 1 && !plan(db, purchaseId)) {
    throw new AppError(
      409,
      "pending_purchase",
      "This purchase is still pending. Mark it as paid in instalments once it has posted.",
    );
  }
  if (p.is_transfer === 1 || p.instalment_of_id !== null) {
    throw new AppError(
      400,
      "not_a_purchase",
      "A transfer or a repayment can't be a purchase paid in instalments.",
    );
  }
  db.insert(instalmentPurchases)
    .values({ transactionId: purchaseId, instalments, createdAt: now })
    .onConflictDoUpdate({ target: instalmentPurchases.transactionId, set: { instalments } })
    .run();
  return getTransaction(db, purchaseId);
}

/** Stops treating a purchase as paid in instalments: every repayment counts as spending again. */
export function unmarkInstalments(db: AppDb, purchaseId: number, now = new Date().toISOString()) {
  load(db, purchaseId);
  db.transaction((tx) => {
    const linked = tx.all<{ id: number }>(
      sql`select id from transactions where instalment_of_id = ${purchaseId}`,
    );
    for (const { id } of linked) restore(tx, id, load(tx, id), now);
    tx.delete(instalmentPurchases).where(eq(instalmentPurchases.transactionId, purchaseId)).run();
  });
}

/** Links a repayment with the purchase it pays off, or (purchaseId null) unlinks it. */
export function linkRepayment(
  db: AppDb,
  repaymentId: number,
  purchaseId: number | null,
  now = new Date().toISOString(),
): TransactionDto {
  const r = load(db, repaymentId);
  if (purchaseId === null) {
    if (r.instalment_of_id !== null) restore(db, repaymentId, r, now);
    return getTransaction(db, repaymentId);
  }
  if (purchaseId === repaymentId) {
    throw new AppError(400, "same_transaction", "Choose the purchase this pays off.");
  }
  const p = load(db, purchaseId);
  if (!plan(db, purchaseId)) {
    throw new AppError(409, "not_instalments", "Mark that purchase as paid in instalments first.");
  }
  if (r.amount <= 0 || r.refund_of_id !== null) {
    throw new AppError(400, "not_a_repayment", "A repayment is money that went out, not a refund.");
  }
  if (r.transfer_pair_id !== null || (r.is_transfer === 1 && r.transfer_source === "auto")) {
    throw new AppError(
      400,
      "not_a_repayment",
      "This is linked as a transfer between your accounts. Unlink that first.",
    );
  }
  if (r.transfer_source === "mirror" || r.mirror_of_id !== null) {
    throw new AppError(
      409,
      "mirror_linked",
      "This is a copy of a purchase another account shows. Unlink it first.",
    );
  }
  if (r.splits > 0) {
    throw new AppError(409, "split_transaction", "Remove the split from this first.");
  }
  if (r.currency !== p.currency) {
    throw new AppError(409, "currency_mismatch", "The two use different currencies.");
  }
  if (r.day < addDays(p.day, -1)) {
    throw new AppError(
      400,
      "repayment_before_purchase",
      "A repayment can't come before its purchase.",
    );
  }
  if (paidBy(db, purchaseId, repaymentId) + r.amount > p.amount) {
    throw new AppError(
      409,
      "repayments_exceed_purchase",
      "That would pay back more than the purchase cost. Leave a fee or interest charge unlinked so it counts as spending.",
    );
  }
  // Already linked (to this or another purchase): what it was before that link is kept.
  const wasLinked = r.instalment_of_id !== null;
  db.update(transactions)
    .set({
      isTransfer: true,
      transferSource: "instalment",
      instalmentOfId: purchaseId,
      ...(wasLinked
        ? {}
        : {
            instalmentPriorTransfer: r.is_transfer === 1,
            instalmentPriorSource: r.transfer_source,
          }),
      updatedAt: now,
    })
    .where(eq(transactions.id, repaymentId))
    .run();
  return getTransaction(db, repaymentId);
}

/** Whether a transaction is a purchase marked as paid in instalments. */
export function isInstalmentPurchase(db: Pick<AppDb, "all">, id: number): boolean {
  return plan(db, id) !== undefined;
}

/**
 * Refuses a change of amount, direction or currency that would break the rules of a link: a
 * repayment must stay money out in the purchase's currency, and repayments together may not come
 * to more than the purchase. `next` is what the transaction would become (no currency: unchanged).
 */
export function checkInstalmentEdit(
  db: Pick<AppDb, "all">,
  id: number,
  next: { amountMinor: number; currency?: string | undefined },
): void {
  const row = load(db, id);
  if (row.instalment_of_id !== null) {
    const p = load(db, row.instalment_of_id);
    if (next.amountMinor <= 0 || (next.currency !== undefined && next.currency !== p.currency)) {
      throw new AppError(
        409,
        "instalment_linked",
        "This pays off a purchase made in instalments, so it must stay money out in the same currency. Unlink it first.",
      );
    }
    if (paidBy(db, p.id, id) + next.amountMinor > p.amount) {
      throw new AppError(
        409,
        "repayments_exceed_purchase",
        "That would pay back more than the purchase cost. Unlink this payment first, or leave a fee unlinked.",
      );
    }
  } else if (plan(db, id)) {
    const linked = db.all<{ n: number; c: number }>(sql`
      select coalesce(sum(amount_minor), 0) as n, count(*) as c from transactions
      where instalment_of_id = ${id}`)[0]!;
    if (
      next.amountMinor <= 0 ||
      (linked.c > 0 && next.currency !== undefined && next.currency !== row.currency)
    ) {
      throw new AppError(
        409,
        "instalment_purchase",
        "This purchase is paid in instalments, so it must stay money out in the same currency. Stop treating it as instalments first.",
      );
    }
    if (linked.n > next.amountMinor) {
      throw new AppError(
        409,
        "repayments_exceed_purchase",
        "The payments already linked come to more than that. Unlink some, or stop treating it as instalments, first.",
      );
    }
  }
}

/**
 * Puts back repayments that no longer fit: their purchase is gone or no longer marked, or a sync
 * changed an amount or currency so the repayments together exceed the purchase (the newest are
 * unlinked until they fit). Part of detection.
 */
export function resetInstalments(tx: Tx, now: string): void {
  const orphans = tx.all<{ id: number }>(sql`
    select id from transactions where instalment_of_id is not null
      and not exists (select 1 from instalment_purchases p where p.transaction_id = instalment_of_id)`);
  for (const { id } of orphans) restore(tx, id, load(tx, id), now);
  // Newest first, so the newest are the ones unlinked.
  const linked = tx.all<{ id: number; of: number }>(sql`
    select id, instalment_of_id as "of" from transactions where instalment_of_id is not null
    order by coalesce(authorized_date, date) desc, id desc`);
  const byPurchase = new Map<number, number[]>();
  for (const r of linked) byPurchase.set(r.of, [...(byPurchase.get(r.of) ?? []), r.id]);
  for (const [purchaseId, ids] of byPurchase) {
    const p = load(tx, purchaseId);
    const rows = ids.map((id) => load(tx, id));
    let total = rows.reduce((n, r) => n + r.amount, 0);
    for (const r of rows) {
      const bad = r.amount <= 0 || r.currency !== p.currency || p.amount <= 0;
      if (bad || total > p.amount) {
        restore(tx, r.id, r, now);
        total -= r.amount;
      }
    }
  }
}

/**
 * Money out that could be a repayment of the purchase: within WINDOW_DAYS days after it, about
 * the purchase divided by the instalments, not linked or a transfer. Wording that reads like an
 * instalment service first, then the nearest date.
 */
export function instalmentCandidates(db: AppDb, purchaseId: number): TransactionDto[] {
  const p = load(db, purchaseId);
  const mark = plan(db, purchaseId);
  if (!mark)
    throw new AppError(409, "not_instalments", "Mark that purchase as paid in instalments first.");
  const each = Math.round(p.amount / mark.instalments);
  const day = sql`coalesce(t.authorized_date, t.date)`;
  const rows = db.all<{ id: number; text: string; days: number }>(sql`
    select t.id, julianday(${day}) - julianday(${p.day}) as days,
      coalesce(t.merchant_name_user, '') || ' ' || coalesce(t.merchant_name, '') || ' ' || t.name as text
    from transactions t join accounts a on a.id = t.account_id
    where t.id <> ${purchaseId} and t.currency = ${p.currency} and t.amount_minor > 0
      and abs(t.amount_minor - ${each}) <= ${AMOUNT_SLACK}
      and t.instalment_of_id is null and t.is_transfer = 0 and t.refund_of_id is null
      and t.mirror_of_id is null and a.hidden = 0
      and not exists (select 1 from instalment_purchases ip where ip.transaction_id = t.id)
      and ${day} >= ${addDays(p.day, -1)} and ${day} <= ${addDays(p.day, WINDOW_DAYS)}`);
  return rows
    .sort(
      (x, y) =>
        Number(INSTALMENT_WORDS.test(y.text)) - Number(INSTALMENT_WORDS.test(x.text)) ||
        x.days - y.days ||
        x.id - y.id,
    )
    .slice(0, MAX_CANDIDATES)
    .map((r) => getTransaction(db, r.id));
}
