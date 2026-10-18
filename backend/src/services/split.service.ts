import { eq } from "drizzle-orm";
import { categories, transactions, transactionSplits } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { checkRefundSplit, reallocateRefundsOf } from "./refund-allocation.service.js";
import { getTransaction, type TransactionDto } from "./transaction.service.js";

/**
 * Splitting a transaction across categories. The parts must add up to the transaction's amount
 * (in cents, same sign: positive is money out); at least two, at most twenty. Saving an empty
 * list un-splits it. Any transaction can be split, a bank's own included: the split only changes
 * how it is counted, never the bank's record. A refund of a split purchase is divided across the
 * purchase's categories instead (see refund-allocation.service), where one part is enough.
 */
export interface SplitInput {
  categoryId: number | null;
  amountMinor: number;
  note?: string | null | undefined;
}

export const MAX_SPLITS = 20;

export function setSplits(
  db: AppDb,
  transactionId: number,
  parts: SplitInput[],
  now: string = new Date().toISOString(),
): TransactionDto {
  const tx = db
    .select({ amountMinor: transactions.amountMinor })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();
  if (!tx) throw notFound("That transaction");
  const refundOfSplit = checkRefundSplit(db, transactionId, parts);
  if (parts.length > MAX_SPLITS) {
    throw new AppError(
      400,
      "invalid_split",
      `A transaction can be split into at most ${MAX_SPLITS} parts.`,
    );
  }
  for (const p of parts) {
    if (!Number.isInteger(p.amountMinor) || p.amountMinor === 0) {
      throw new AppError(400, "invalid_split", "Each part needs an amount.");
    }
    if (p.categoryId !== null) {
      const c = db
        .select({ active: categories.active })
        .from(categories)
        .where(eq(categories.id, p.categoryId))
        .get();
      if (!c) throw new AppError(400, "unknown_category", "That category does not exist.");
    }
  }
  const total = parts.reduce((n, p) => n + p.amountMinor, 0);
  // A purchase with reimbursements linked may be split by what was kept: the parts then add up to
  // the purchase less what came back. Those parts are all it counts as, and the reimbursements
  // (already taken off) are left out of totals (see the transaction_lines view).
  const reimbursed = tx.amountMinor > 0 ? reimbursedOf(db, transactionId) : null;
  const keptOnly =
    reimbursed !== null &&
    parts.length > 0 &&
    total === tx.amountMinor - reimbursed.amountMinor &&
    total > 0;
  if (parts.length > 0 && total !== tx.amountMinor && !keptOnly) {
    const dollars = (minor: number) => `$${(Math.abs(minor) / 100).toFixed(2)}`;
    throw new AppError(
      400,
      "split_total",
      reimbursed
        ? `The parts add up to ${dollars(total)}, but the transaction is ${dollars(tx.amountMinor)} ` +
            `(${dollars(tx.amountMinor - reimbursed.amountMinor)} after what was reimbursed).`
        : `The parts add up to ${dollars(total)}, but the transaction is ${dollars(tx.amountMinor)}.`,
    );
  }
  if (parts.length === 1 && !refundOfSplit && !keptOnly) {
    throw new AppError(
      400,
      "invalid_split",
      "A split needs at least two parts. Remove it instead.",
    );
  }
  if (keptOnly && parts.some((p) => p.amountMinor < 0)) {
    throw new AppError(400, "invalid_split", "Each part of what you kept is money spent.");
  }
  db.transaction((t) => {
    t.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();
    parts.forEach((p, position) => {
      t.insert(transactionSplits)
        .values({
          transactionId,
          categoryId: p.categoryId,
          amountMinor: p.amountMinor,
          note: p.note?.trim() || null,
          position,
          createdAt: now,
        })
        .run();
    });
    // The refunds of this purchase follow its categories; split by what was kept, the purchase is
    // not split in full, so its reimbursements keep no split of their own (just their category).
    reallocateRefundsOf(t, transactionId, now);
  });
  return getTransaction(db, transactionId);
}

/** What the reimbursements (refunds) linked to a purchase give back in all, or null. */
function reimbursedOf(
  db: Pick<AppDb, "select">,
  originalId: number,
): { amountMinor: number } | null {
  const rows = db
    .select({ amountMinor: transactions.amountMinor })
    .from(transactions)
    .where(eq(transactions.refundOfId, originalId))
    .all();
  if (rows.length === 0) return null;
  const amountMinor = -rows.reduce((n, r) => n + r.amountMinor, 0);
  return amountMinor > 0 ? { amountMinor } : null;
}

/**
 * Whether a purchase is split by what was kept: its parts add up to the purchase less what its
 * reimbursements gave back. Its reimbursements then count nowhere else.
 */
export function isKeptSplit(db: Pick<AppDb, "select">, id: number): boolean {
  const tx = db
    .select({ amountMinor: transactions.amountMinor })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!tx || tx.amountMinor <= 0) return false;
  const reimbursed = reimbursedOf(db, id);
  if (!reimbursed) return false;
  const parts = db
    .select({ amountMinor: transactionSplits.amountMinor })
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, id))
    .all();
  return (
    parts.length > 0 &&
    parts.reduce((n, p) => n + p.amountMinor, 0) === tx.amountMinor - reimbursed.amountMinor
  );
}
