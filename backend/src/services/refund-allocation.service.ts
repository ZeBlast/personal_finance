import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";

/**
 * A refund of a split purchase, divided across the purchase's categories. The refund's own split
 * lines say how much comes back to each category (the transaction_lines view counts each line in
 * its category, on the purchase's date). A category never gets back more than was spent in it,
 * across all the refunds of the purchase. A refund the user has not divided is divided in
 * proportion to what is left in each category.
 *
 * Amounts here are positive cents (what was spent, what comes back), unlike the ledger's signs.
 */

type Db = Pick<AppDb, "all" | "run">;

export interface RefundAllocationLine {
  categoryId: number | null;
  categoryName: string | null;
  /** What the purchase spent in this category. */
  spentMinor: number;
  /** What the purchase's other refunds give back to it. */
  refundedElsewhereMinor: number;
  /** What this refund can still give back to it. */
  leftMinor: number;
  /** What this refund gives back to it now (its split, or the proportional default). */
  thisMinor: number;
}

export interface RefundAllocation {
  refundId: number;
  originalId: number;
  /** What the refund gives back in all. */
  refundMinor: number;
  /**
   * True when the refund's own split decides it (set by the user, or the proportional default
   * saved when it was linked); false when that split is missing or no longer fits.
   */
  chosen: boolean;
  lines: RefundAllocationLine[];
}

/**
 * `total` cents in proportion to `weights`, adding up to `total` exactly: each share rounds down,
 * and the leftover cents go to the largest remainders (the first on a tie). With no weight at all,
 * the shares are equal. Pure, for testing.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  const basis = sum > 0 ? w : w.map(() => 1);
  const basisSum = sum > 0 ? sum : w.length;
  const exact = basis.map((x) => (total * x) / basisSum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

const key = (categoryId: number | null): string => String(categoryId);

/** A transaction's split lines when they add up to it (otherwise it counts whole: none). */
function validSplits(
  db: Db,
  id: number,
): Array<{ categoryId: number | null; amountMinor: number }> {
  const rows = db.all<{ category_id: number | null; amount_minor: number; total: number }>(sql`
    select s.category_id, s.amount_minor, t.amount_minor as total
    from transaction_splits s join transactions t on t.id = s.transaction_id
    where s.transaction_id = ${id} order by s.position, s.id`);
  if (rows.length === 0) return [];
  const sum = rows.reduce((n, r) => n + r.amount_minor, 0);
  if (sum !== rows[0]!.total) return [];
  return rows.map((r) => ({ categoryId: r.category_id, amountMinor: r.amount_minor }));
}

/** What a split purchase spent in each of its categories, in the order they first appear. */
function spentByCategory(
  db: Db,
  originalId: number,
): Array<{ categoryId: number | null; spentMinor: number }> | null {
  const splits = validSplits(db, originalId);
  if (splits.length === 0) return null;
  const out = new Map<string, { categoryId: number | null; spentMinor: number }>();
  for (const s of splits) {
    const line = out.get(key(s.categoryId)) ?? { categoryId: s.categoryId, spentMinor: 0 };
    line.spentMinor += s.amountMinor;
    out.set(key(s.categoryId), line);
  }
  return [...out.values()];
}

/**
 * How one refund of a split purchase is divided by category: its own split when that fits the
 * purchase's categories, otherwise in proportion to `weights`.
 */
function refundShares(
  db: Db,
  refundId: number,
  refundMinor: number,
  categories: Array<{ categoryId: number | null }>,
  weights: number[],
): { shares: Map<string, number>; chosen: boolean } {
  const own = validSplits(db, refundId);
  const known = new Set(categories.map((c) => key(c.categoryId)));
  if (own.length > 0 && own.every((s) => s.amountMinor < 0 && known.has(key(s.categoryId)))) {
    const shares = new Map<string, number>();
    for (const s of own) {
      shares.set(key(s.categoryId), (shares.get(key(s.categoryId)) ?? 0) - s.amountMinor);
    }
    return { shares, chosen: true };
  }
  const amounts = allocateProportionally(refundMinor, weights);
  return {
    shares: new Map(categories.map((c, i) => [key(c.categoryId), amounts[i] ?? 0])),
    chosen: false,
  };
}

/** The refunds of a purchase other than one: id and what each gives back (positive cents). */
function otherRefunds(db: Db, originalId: number, except: number) {
  return db.all<{ id: number; amount: number }>(sql`
    select id, -amount_minor as amount from transactions
    where refund_of_id = ${originalId} and id <> ${except} order by id`);
}

/**
 * How a refund linked to a split purchase is divided across the purchase's categories, with what
 * each category spent, what the purchase's other refunds already give back to it, and what is
 * left. Null when the refund is not linked, or its purchase is not split.
 */
export function refundAllocation(db: Db, refundId: number): RefundAllocation | null {
  const refund = db.all<{ amount: number; refund_of_id: number | null }>(sql`
    select -amount_minor as amount, refund_of_id from transactions where id = ${refundId}`)[0];
  if (!refund || refund.refund_of_id === null) return null;
  const originalId = refund.refund_of_id;
  const spent = spentByCategory(db, originalId);
  if (!spent) return null;

  const elsewhere = new Map<string, number>();
  for (const other of otherRefunds(db, originalId, refundId)) {
    const { shares } = refundShares(
      db,
      other.id,
      other.amount,
      spent,
      spent.map((s) => s.spentMinor),
    );
    for (const [k, v] of shares) elsewhere.set(k, (elsewhere.get(k) ?? 0) + v);
  }
  const left = spent.map((s) =>
    Math.max(0, s.spentMinor - (elsewhere.get(key(s.categoryId)) ?? 0)),
  );
  const { shares, chosen } = refundShares(db, refundId, refund.amount, spent, left);
  const names = new Map(
    db
      .all<{ id: number; name: string }>(sql`select id, name from categories`)
      .map((c) => [c.id, c.name]),
  );
  return {
    refundId,
    originalId,
    refundMinor: refund.amount,
    chosen,
    lines: spent.map((s, i) => ({
      categoryId: s.categoryId,
      categoryName: s.categoryId === null ? null : (names.get(s.categoryId) ?? null),
      spentMinor: s.spentMinor,
      refundedElsewhereMinor: elsewhere.get(key(s.categoryId)) ?? 0,
      leftMinor: left[i]!,
      thisMinor: shares.get(key(s.categoryId)) ?? 0,
    })),
  };
}

/**
 * Checks a split for a refund of a split purchase: every part gives money back (same sign as the
 * refund), goes to one of the purchase's categories, and no category gets back more than what is
 * left in it. Returns false when the refund is not one of these (the ordinary split rules apply).
 */
export function checkRefundSplit(
  db: Db,
  refundId: number,
  parts: Array<{ categoryId: number | null; amountMinor: number }>,
): boolean {
  const allocation = refundAllocation(db, refundId);
  if (!allocation) return false;
  if (parts.length === 0) return true;
  const byCategory = new Map(allocation.lines.map((l) => [key(l.categoryId), l]));
  const asked = new Map<string, number>();
  for (const p of parts) {
    if (p.amountMinor >= 0) {
      throw new AppError(400, "invalid_split", "Each part of a refund gives money back.");
    }
    const line = byCategory.get(key(p.categoryId));
    if (!line) {
      throw new AppError(
        400,
        "refund_category",
        "A refund can only go back to the categories of the purchase it gives back.",
      );
    }
    asked.set(key(p.categoryId), (asked.get(key(p.categoryId)) ?? 0) - p.amountMinor);
  }
  for (const [k, amount] of asked) {
    const line = byCategory.get(k)!;
    if (amount > line.leftMinor) {
      const dollars = (minor: number) => `$${(minor / 100).toFixed(2)}`;
      throw new AppError(
        409,
        "refund_exceeds_category",
        `${line.categoryName ?? "Uncategorized"} has ${dollars(line.leftMinor)} left to give back, ` +
          `not ${dollars(amount)}.`,
      );
    }
  }
  return true;
}

function writeSplits(
  db: Db,
  id: number,
  parts: Array<{ categoryId: number | null; amountMinor: number }>,
  now: string,
): void {
  db.run(sql`delete from transaction_splits where transaction_id = ${id}`);
  parts.forEach((p, position) => {
    db.run(sql`insert into transaction_splits
      (transaction_id, category_id, amount_minor, note, position, created_at)
      values (${id}, ${p.categoryId}, ${p.amountMinor}, null, ${position}, ${now})`);
  });
}

/**
 * Gives a refund of a split purchase a split that fits it: its own, if it still fits, else one in
 * proportion to what is left in each category. A refund that is not linked to a split purchase is
 * left alone. Returns true when it changed the refund's split.
 */
export function ensureRefundAllocation(db: Db, refundId: number, now: string): boolean {
  const allocation = refundAllocation(db, refundId);
  if (!allocation || allocation.chosen) return false;
  const parts = allocation.lines
    .filter((l) => l.thisMinor > 0)
    .map((l) => ({ categoryId: l.categoryId, amountMinor: -l.thisMinor }));
  writeSplits(db, refundId, parts, now);
  return true;
}

/** Removes a refund's split (when it stops giving back a split purchase). */
export function clearRefundAllocation(db: Db, refundId: number): void {
  db.run(sql`delete from transaction_splits where transaction_id = ${refundId}`);
}

/**
 * Every refund of a purchase gives back all of itself to one of the purchase's categories: the
 * reimbursed part made when the purchase is split by what was kept.
 */
export function allocateRefundsToCategory(
  db: Db,
  originalId: number,
  categoryId: number | null,
  now: string,
): void {
  const refunds = db.all<{ id: number; amount_minor: number }>(sql`
    select id, amount_minor from transactions where refund_of_id = ${originalId}`);
  for (const r of refunds) {
    writeSplits(db, r.id, [{ categoryId, amountMinor: r.amount_minor }], now);
  }
}

/**
 * After a purchase's split changes: each of its refunds keeps its own split if it still fits,
 * and is otherwise divided again in proportion; when the purchase is no longer split, the
 * refunds' splits (which divided them by its categories) are removed. Returns how many changed.
 */
export function reallocateRefundsOf(db: Db, originalId: number, now: string): number {
  const refunds = db.all<{ id: number }>(sql`
    select id from transactions where refund_of_id = ${originalId} order by id`);
  if (refunds.length === 0) return 0;
  if (!spentByCategory(db, originalId)) {
    let changed = 0;
    for (const r of refunds) {
      if (validSplits(db, r.id).length > 0) {
        clearRefundAllocation(db, r.id);
        changed += 1;
      }
    }
    return changed;
  }
  // A refund whose split overshoots a category after the change is divided again.
  let changed = 0;
  for (const r of refunds) {
    const allocation = refundAllocation(db, r.id);
    if (!allocation) continue;
    const over = allocation.lines.some((l) => l.thisMinor > l.leftMinor);
    if (allocation.chosen && !over) continue;
    clearRefundAllocation(db, r.id);
    if (ensureRefundAllocation(db, r.id, now)) changed += 1;
  }
  return changed;
}
