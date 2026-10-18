import { and, asc, eq } from "drizzle-orm";
import { budgets, categories } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addMonths, firstOfMonth, isRealDate, isRealMonth, lastOfMonth } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { categorySpending, summarize } from "./analytics.service.js";

export interface BudgetDto {
  id: number;
  categoryId: number;
  categoryName: string;
  categoryColor: string | null;
  parentId: number | null;
  amountMinor: number;
  rollover: Rollover;
  /** Carried in from last month's budget for the category (negative after overspending). */
  carryInMinor: number;
  /** What there is to spend this month: the amount plus what carried in. */
  availableMinor: number;
  /** Net spending in the category and its subcategories during the month. */
  spentMinor: number;
  /** Available minus spent: what carries into next month when rollover is on. */
  remainingMinor: number;
  /** Whole percent of what is available used; can exceed 100. */
  percentUsed: number;
  overspent: boolean;
  /** A fund saved toward an irregular expense, or null. */
  fund: {
    targetMinor: number;
    targetDate: string;
    /** Months from this one through the target's month (at least 1). */
    monthsLeft: number;
    /** What to set aside each month from now to have it by then. */
    suggestedMinor: number;
    reached: boolean;
  } | null;
}

export const ROLLOVERS = ["off", "all", "leftover"] as const;
export type Rollover = (typeof ROLLOVERS)[number];

export interface BudgetOptions {
  rollover?: Rollover | undefined;
  fundTargetMinor?: number | null | undefined;
  fundTargetDate?: string | null | undefined;
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

type BudgetRow = typeof budgets.$inferSelect;

/** Whole months from one month through another, counting both, at least 1. */
export function monthsThrough(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

/** What last month's budget for the category leaves this month: its end, if it rolls over. */
function carryInto(
  db: AppDb,
  categoryId: number,
  month: string,
  environment: string,
  depth = 0,
): number {
  // Five years back is far more than any carried amount needs.
  if (depth >= 60) return 0;
  const prevMonth = addMonths(month, -1);
  const prev = db
    .select()
    .from(budgets)
    .where(and(eq(budgets.categoryId, categoryId), eq(budgets.periodStart, periodOf(prevMonth))))
    .get();
  if (!prev || prev.rollover === "off") return 0;
  const end =
    prev.amountMinor +
    carryInto(db, categoryId, prevMonth, environment, depth + 1) -
    categorySpending(db, categoryId, prevMonth, environment);
  return prev.rollover === "leftover" ? Math.max(0, end) : end;
}

function toDto(db: AppDb, row: BudgetRow, environment: string): BudgetDto {
  const month = row.periodStart.slice(0, 7);
  const category = db.select().from(categories).where(eq(categories.id, row.categoryId)).get()!;
  const spentMinor = categorySpending(db, row.categoryId, month, environment);
  const carryInMinor = carryInto(db, row.categoryId, month, environment);
  const availableMinor = row.amountMinor + carryInMinor;
  let fund: BudgetDto["fund"] = null;
  if (row.fundTargetMinor !== null && row.fundTargetDate !== null) {
    const monthsLeft = monthsThrough(month, row.fundTargetDate.slice(0, 7));
    // What carried in is what the fund has saved so far.
    const toGo = Math.max(0, row.fundTargetMinor - carryInMinor);
    fund = {
      targetMinor: row.fundTargetMinor,
      targetDate: row.fundTargetDate,
      monthsLeft,
      suggestedMinor: Math.ceil(toGo / monthsLeft),
      reached: toGo === 0,
    };
  }
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: category.name,
    categoryColor: category.color,
    parentId: category.parentId,
    amountMinor: row.amountMinor,
    rollover: (ROLLOVERS as readonly string[]).includes(row.rollover)
      ? (row.rollover as Rollover)
      : "off",
    carryInMinor,
    availableMinor,
    spentMinor,
    remainingMinor: availableMinor - spentMinor,
    percentUsed: availableMinor > 0 ? Math.round((spentMinor / availableMinor) * 100) : 0,
    overspent: spentMinor > availableMinor,
    fund,
  };
}

function checkOptions(o: BudgetOptions): void {
  if (o.fundTargetDate != null && !isRealDate(o.fundTargetDate)) {
    throw new AppError(400, "invalid_date", "Enter the fund's date as YYYY-MM-DD.");
  }
  if ((o.fundTargetMinor == null) !== (o.fundTargetDate == null)) {
    throw new AppError(400, "invalid_fund", "A fund needs both an amount and a date.");
  }
}

function byId(db: AppDb, id: number): BudgetRow {
  const row = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!row) throw notFound("That budget");
  return row;
}

/** The budgets of one month with what has been spent against each. Archived categories are hidden. */
export function budgetMonth(db: AppDb, month: string, environment: string): BudgetMonth {
  requireMonth(month);
  const rows = db
    .select({ budget: budgets })
    .from(budgets)
    .innerJoin(categories, eq(budgets.categoryId, categories.id))
    .where(and(eq(budgets.periodStart, periodOf(month)), eq(categories.active, true)))
    .orderBy(asc(categories.name))
    .all();

  const list = rows.map((row) => toDto(db, row.budget, environment));
  // What there is to spend, carried amounts included, so "left" adds up across the page.
  const budgetedMinor = list.reduce((sum, b) => sum + b.availableMinor, 0);
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
  input: { categoryId: number; month: string; amountMinor: number } & BudgetOptions,
  environment: string,
): BudgetDto {
  requireMonth(input.month);
  checkOptions(input);
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
      rollover: input.rollover ?? "off",
      fundTargetMinor: input.fundTargetMinor ?? null,
      fundTargetDate: input.fundTargetDate ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDto(db, created, environment);
}

export function updateBudget(
  db: AppDb,
  id: number,
  patch: { amountMinor?: number | undefined } & BudgetOptions,
  environment: string,
): BudgetDto {
  const row = byId(db, id);
  const next = {
    amountMinor: patch.amountMinor ?? row.amountMinor,
    rollover: patch.rollover ?? (row.rollover as Rollover),
    fundTargetMinor:
      patch.fundTargetMinor !== undefined ? patch.fundTargetMinor : row.fundTargetMinor,
    fundTargetDate: patch.fundTargetDate !== undefined ? patch.fundTargetDate : row.fundTargetDate,
  };
  checkOptions(next);
  db.update(budgets)
    .set({ ...next, updatedAt: new Date().toISOString() })
    .where(eq(budgets.id, id))
    .run();
  return toDto(db, byId(db, id), environment);
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
      rollover: budgets.rollover,
      fundTargetMinor: budgets.fundTargetMinor,
      fundTargetDate: budgets.fundTargetDate,
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
          rollover: row.rollover,
          fundTargetMinor: row.fundTargetMinor,
          fundTargetDate: row.fundTargetDate,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created += 1;
    }
  });
  return { created, skipped };
}
