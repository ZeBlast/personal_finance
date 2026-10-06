import { and, asc, eq } from "drizzle-orm";
import { budgets, categories } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { firstOfMonth, isRealMonth, lastOfMonth } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { categorySpending, summarize } from "./analytics.service.js";

export interface BudgetDto {
  id: number;
  categoryId: number;
  categoryName: string;
  categoryColor: string | null;
  parentId: number | null;
  amountMinor: number;
  /** Net spending in the category and its subcategories during the month. */
  spentMinor: number;
  remainingMinor: number;
  /** Whole percent of the budget used; can exceed 100. */
  percentUsed: number;
  overspent: boolean;
}

export interface BudgetMonth {
  month: string;
  budgets: BudgetDto[];
  totals: { budgetedMinor: number; spentMinor: number; remainingMinor: number };
  /** Spending in the month that no budget covers, for a sense of what is unplanned. */
  unbudgetedSpendingMinor: number;
}

const periodOf = (month: string): string => `${month}-01`;

function requireMonth(month: string): void {
  if (!isRealMonth(month))
    throw new AppError(400, "invalid_month", "Month must be written YYYY-MM.");
}

function requireActiveCategory(db: AppDb, id: number): void {
  const category = db
    .select({ active: categories.active })
    .from(categories)
    .where(eq(categories.id, id))
    .get();
  if (!category) throw new AppError(400, "unknown_category", "That category does not exist.");
  if (!category.active) {
    throw new AppError(400, "inactive_category", "That category is archived. Restore it first.");
  }
}

function toDto(
  db: AppDb,
  row: { id: number; categoryId: number; amountMinor: number },
  month: string,
  environment: string,
): BudgetDto {
  const category = db.select().from(categories).where(eq(categories.id, row.categoryId)).get()!;
  const spentMinor = categorySpending(db, row.categoryId, month, environment);
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: category.name,
    categoryColor: category.color,
    parentId: category.parentId,
    amountMinor: row.amountMinor,
    spentMinor,
    remainingMinor: row.amountMinor - spentMinor,
    percentUsed: row.amountMinor > 0 ? Math.round((spentMinor / row.amountMinor) * 100) : 0,
    overspent: spentMinor > row.amountMinor,
  };
}

/** The budgets of one month with what has been spent against each. Archived categories are hidden. */
export function budgetMonth(db: AppDb, month: string, environment: string): BudgetMonth {
  requireMonth(month);
  const rows = db
    .select({
      id: budgets.id,
      categoryId: budgets.categoryId,
      amountMinor: budgets.amountMinor,
      name: categories.name,
    })
    .from(budgets)
    .innerJoin(categories, eq(budgets.categoryId, categories.id))
    .where(and(eq(budgets.periodStart, periodOf(month)), eq(categories.active, true)))
    .orderBy(asc(categories.name))
    .all();

  const list = rows.map((row) => toDto(db, row, month, environment));
  const budgetedMinor = list.reduce((sum, b) => sum + b.amountMinor, 0);
  const spentMinor = list.reduce((sum, b) => sum + b.spentMinor, 0);

  // Spending not covered by any budgeted category (or the subcategories of one).
  const covered = new Set<number>();
  for (const b of list) covered.add(b.categoryId);
  const all = summarize(db, {
    from: firstOfMonth(month),
    to: lastOfMonth(month),
    groupBy: "category",
    includeTransfers: false,
    includePending: true,
    fill: false,
    environment,
  });
  const parentOf = new Map(
    db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories)
      .all()
      .map((c) => [c.id, c.parentId] as const),
  );
  let unbudgeted = 0;
  for (const row of all.rows) {
    const id = Number(row.key);
    const parent = parentOf.get(id) ?? null;
    if (id !== 0 && (covered.has(id) || (parent !== null && covered.has(parent)))) continue;
    unbudgeted += row.spendingMinor;
  }

  return {
    month,
    budgets: list,
    totals: { budgetedMinor, spentMinor, remainingMinor: budgetedMinor - spentMinor },
    unbudgetedSpendingMinor: unbudgeted,
  };
}

export function createBudget(
  db: AppDb,
  input: { categoryId: number; month: string; amountMinor: number },
  environment: string,
): BudgetDto {
  requireMonth(input.month);
  requireActiveCategory(db, input.categoryId);
  const existing = db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(eq(budgets.categoryId, input.categoryId), eq(budgets.periodStart, periodOf(input.month))),
    )
    .get();
  if (existing) {
    throw new AppError(
      409,
      "duplicate_budget",
      "That category already has a budget for this month.",
    );
  }
  const now = new Date().toISOString();
  const created = db
    .insert(budgets)
    .values({
      categoryId: input.categoryId,
      periodStart: periodOf(input.month),
      amountMinor: input.amountMinor,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: budgets.id, categoryId: budgets.categoryId, amountMinor: budgets.amountMinor })
    .get();
  return toDto(db, created, input.month, environment);
}

export function updateBudget(
  db: AppDb,
  id: number,
  amountMinor: number,
  environment: string,
): BudgetDto {
  const row = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!row) throw notFound("That budget");
  db.update(budgets)
    .set({ amountMinor, updatedAt: new Date().toISOString() })
    .where(eq(budgets.id, id))
    .run();
  return toDto(
    db,
    { id, categoryId: row.categoryId, amountMinor },
    row.periodStart.slice(0, 7),
    environment,
  );
}

export function deleteBudget(db: AppDb, id: number): void {
  if (!db.select({ id: budgets.id }).from(budgets).where(eq(budgets.id, id)).get()) {
    throw notFound("That budget");
  }
  db.delete(budgets).where(eq(budgets.id, id)).run();
}

/**
 * Copies one month's budgets into another, for categories that do not already have one there
 * (nothing existing is overwritten). Archived categories are skipped.
 */
export function copyBudgets(
  db: AppDb,
  fromMonth: string,
  toMonth: string,
): { created: number; skipped: number } {
  requireMonth(fromMonth);
  requireMonth(toMonth);
  if (fromMonth === toMonth) {
    throw new AppError(400, "invalid_copy", "Choose a different month to copy from.");
  }
  const source = db
    .select({
      categoryId: budgets.categoryId,
      amountMinor: budgets.amountMinor,
      active: categories.active,
    })
    .from(budgets)
    .innerJoin(categories, eq(budgets.categoryId, categories.id))
    .where(eq(budgets.periodStart, periodOf(fromMonth)))
    .all();
  const now = new Date().toISOString();
  let created = 0;
  let skipped = 0;
  db.transaction((tx) => {
    for (const row of source) {
      const exists = tx
        .select({ id: budgets.id })
        .from(budgets)
        .where(
          and(eq(budgets.categoryId, row.categoryId), eq(budgets.periodStart, periodOf(toMonth))),
        )
        .get();
      if (exists || !row.active) {
        skipped += 1;
        continue;
      }
      tx.insert(budgets)
        .values({
          categoryId: row.categoryId,
          periodStart: periodOf(toMonth),
          amountMinor: row.amountMinor,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created += 1;
    }
  });
  return { created, skipped };
}
