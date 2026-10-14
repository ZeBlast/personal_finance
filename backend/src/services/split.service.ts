import { eq } from "drizzle-orm";
import { categories, transactions, transactionSplits } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import {
  allocateRefundsToCategory,
  checkRefundSplit,
  reallocateRefundsOf,
} from "./refund-allocation.service.js";
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
  // the purchase less what came back, and the reimbursed amount becomes a part of its own, which
  // the reimbursements give back in full.
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
  if (keptOnly && parts.length + 1 > MAX_SPLITS) {
    throw new AppError(
      400,
      "invalid_split",
      `With the reimbursed part, split into at most ${MAX_SPLITS - 1} parts.`,
    );
  }
  if (keptOnly && parts.some((p) => p.amountMinor < 0)) {
    throw new AppError(400, "invalid_split", "Each part of what you kept is money spent.");
  }
  const saved: SplitInput[] = keptOnly
    ? [
        ...parts,
        {
          categoryId: reimbursed!.categoryId,
          amountMinor: reimbursed!.amountMinor,
          note: REIMBURSED_NOTE,
        },
      ]
    : parts;
  db.transaction((t) => {
    t.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();
    saved.forEach((p, position) => {
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
    if (keptOnly) {
      // Each reimbursement gives back the reimbursed part, so what was kept is what counts.
      allocateRefundsToCategory(t, transactionId, reimbursed!.categoryId, now);
    } else {
      // The refunds of this purchase follow its categories.
      reallocateRefundsOf(t, transactionId, now);
    }
  });
  return getTransaction(db, transactionId);
}

/** The note on the part of a purchase that was reimbursed, made when it is split by what was kept. */
export const REIMBURSED_NOTE = "Reimbursed";

/**
 * What the reimbursements (refunds) linked to a purchase give back in all, and the category to
 * file that part under: theirs when they all share one, else none. Null when nothing is linked.
 */
function reimbursedOf(
  db: AppDb,
  originalId: number,
): { amountMinor: number; categoryId: number | null } | null {
  const rows = db
    .select({ amountMinor: transactions.amountMinor, categoryId: transactions.categoryId })
    .from(transactions)
    .where(eq(transactions.refundOfId, originalId))
    .all();
  if (rows.length === 0) return null;
  const amountMinor = -rows.reduce((n, r) => n + r.amountMinor, 0);
  if (amountMinor <= 0) return null;
  const first = rows[0]!.categoryId;
  return { amountMinor, categoryId: rows.every((r) => r.categoryId === first) ? first : null };
}
