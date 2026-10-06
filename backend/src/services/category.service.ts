import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  appSettings,
  budgets,
  categories,
  transactionRules,
  transactions,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { applyRules } from "./rule.service.js";

export const NAME_MAX = 60;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface CategoryDto {
  id: number;
  name: string;
  parentId: number | null;
  color: string | null;
  active: boolean;
  transactionCount: number;
  ruleCount: number;
}

type CategoryRow = typeof categories.$inferSelect;

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new AppError(400, "invalid_name", `A category name must be 1 to ${NAME_MAX} characters.`);
  }
  return name;
}

function cleanColor(color: string | null | undefined): string | null {
  if (color === null || color === undefined || color === "") return null;
  if (!COLOR_PATTERN.test(color)) {
    throw new AppError(400, "invalid_color", "Use a color like #2563eb.");
  }
  return color.toLowerCase();
}

function requireCategory(db: Pick<AppDb, "select">, id: number): CategoryRow {
  const row = db.select().from(categories).where(eq(categories.id, id)).get();
  if (!row) throw notFound("That category");
  return row;
}

/** Counts of transactions, rules and child categories using a category. */
function usage(db: Pick<AppDb, "select">, id: number) {
  const transactionCount =
    db.select({ n: count() }).from(transactions).where(eq(transactions.categoryId, id)).get()?.n ??
    0;
  const ruleCount =
    db
      .select({ n: count() })
      .from(transactionRules)
      .where(eq(transactionRules.categoryId, id))
      .get()?.n ?? 0;
  const childCount =
    db.select({ n: count() }).from(categories).where(eq(categories.parentId, id)).get()?.n ?? 0;
  const budgetCount =
    db.select({ n: count() }).from(budgets).where(eq(budgets.categoryId, id)).get()?.n ?? 0;
  return { transactionCount, ruleCount, childCount, budgetCount };
}

function assertNameFree(
  db: Pick<AppDb, "select">,
  name: string,
  parentId: number | null,
  exceptId?: number,
): void {
  const clash = db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        sql`lower(${categories.name}) = lower(${name})`,
        parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
        exceptId === undefined ? undefined : ne(categories.id, exceptId),
      ),
    )
    .get();
  if (clash) {
    throw new AppError(409, "duplicate_name", `There is already a category called “${name}” here.`);
  }
}

/** Categories nest one level only: a parent must be a top-level, active category. */
function assertValidParent(db: AppDb, parentId: number, selfId?: number): void {
  if (parentId === selfId)
    throw new AppError(400, "invalid_parent", "A category cannot be its own parent.");
  const parent = requireCategory(db, parentId);
  if (parent.parentId !== null) {
    throw new AppError(400, "too_deep", "Categories can only be nested one level deep.");
  }
  if (!parent.active)
    throw new AppError(400, "inactive_parent", "That parent category is archived.");
  if (selfId !== undefined && usage(db, selfId).childCount > 0) {
    throw new AppError(
      400,
      "too_deep",
      "A category that has subcategories cannot become a subcategory.",
    );
  }
}

export function listCategories(db: AppDb, includeInactive: boolean): CategoryDto[] {
  const rows = db
    .select()
    .from(categories)
    .where(includeInactive ? undefined : eq(categories.active, true))
    .orderBy(asc(categories.name))
    .all();
  const txCounts = new Map(
    db
      .select({ id: transactions.categoryId, n: count() })
      .from(transactions)
      .groupBy(transactions.categoryId)
      .all()
      .map((r) => [r.id, r.n] as const),
  );
  const ruleCounts = new Map(
    db
      .select({ id: transactionRules.categoryId, n: count() })
      .from(transactionRules)
      .groupBy(transactionRules.categoryId)
      .all()
      .map((r) => [r.id, r.n] as const),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    color: row.color,
    active: row.active,
    transactionCount: txCounts.get(row.id) ?? 0,
    ruleCount: ruleCounts.get(row.id) ?? 0,
  }));
}

export function getCategory(db: AppDb, id: number): CategoryDto {
  const row = requireCategory(db, id);
  const used = usage(db, id);
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    color: row.color,
    active: row.active,
    transactionCount: used.transactionCount,
    ruleCount: used.ruleCount,
  };
}

export function createCategory(
  db: AppDb,
  input: { name: string; parentId?: number | null | undefined; color?: string | null | undefined },
): CategoryDto {
  const name = cleanName(input.name);
  const parentId = input.parentId ?? null;
  if (parentId !== null) assertValidParent(db, parentId);
  assertNameFree(db, name, parentId);
  const now = new Date().toISOString();
  const created = db
    .insert(categories)
    .values({
      name,
      parentId,
      color: cleanColor(input.color),
      active: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: categories.id })
    .get();
  return getCategory(db, created.id);
}

export function updateCategory(
  db: AppDb,
  id: number,
  patch: {
    name?: string | undefined;
    parentId?: number | null | undefined;
    color?: string | null | undefined;
    active?: boolean | undefined;
  },
): CategoryDto {
  const current = requireCategory(db, id);
  const name = patch.name === undefined ? current.name : cleanName(patch.name);
  const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
  if (patch.parentId !== undefined && parentId !== null) assertValidParent(db, parentId, id);
  if (name !== current.name || parentId !== current.parentId)
    assertNameFree(db, name, parentId, id);

  db.transaction((tx) => {
    tx.update(categories)
      .set({
        name,
        parentId,
        ...(patch.color === undefined ? {} : { color: cleanColor(patch.color) }),
        ...(patch.active === undefined ? {} : { active: patch.active }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(categories.id, id))
      .run();
    // Archiving a group archives its subcategories too. Restoring does not bring them back, so the
    // user can choose which ones to restore.
    if (patch.active === false) {
      tx.update(categories).set({ active: false }).where(eq(categories.parentId, id)).run();
    }
  });
  return getCategory(db, id);
}

export type DeleteOutcome = "deleted" | "archived";

/**
 * Removes a category the safe way:
 * - never used: deleted for real;
 * - used by transactions or rules (or has subcategories): archived, so history keeps its meaning
 *   and the category disappears from pickers;
 * - `reassignTo` given: its transactions and rules move to that category, then it is deleted.
 */
export function deleteCategory(
  db: AppDb,
  id: number,
  reassignTo?: number,
): { outcome: DeleteOutcome; transactionCount: number; ruleCount: number } {
  requireCategory(db, id);
  const used = usage(db, id);

  if (reassignTo !== undefined) {
    if (reassignTo === id)
      throw new AppError(400, "invalid_target", "Choose a different category.");
    if (used.childCount > 0) {
      throw new AppError(409, "has_children", "Move or archive its subcategories first.");
    }
    const target = requireCategory(db, reassignTo);
    if (!target.active) throw new AppError(400, "inactive_category", "That category is archived.");
    db.transaction((tx) => {
      tx.update(transactions)
        .set({ categoryId: reassignTo })
        .where(eq(transactions.categoryId, id))
        .run();
      tx.update(transactionRules)
        .set({ categoryId: reassignTo })
        .where(eq(transactionRules.categoryId, id))
        .run();
      // Budgets move too, except for months where the target already has its own budget, which
      // wins (a category can only have one budget per month).
      const taken = new Set(
        tx
          .select({ period: budgets.periodStart })
          .from(budgets)
          .where(eq(budgets.categoryId, reassignTo))
          .all()
          .map((row) => row.period),
      );
      for (const budget of tx.select().from(budgets).where(eq(budgets.categoryId, id)).all()) {
        if (taken.has(budget.periodStart)) {
          tx.delete(budgets).where(eq(budgets.id, budget.id)).run();
        } else {
          tx.update(budgets).set({ categoryId: reassignTo }).where(eq(budgets.id, budget.id)).run();
        }
      }
      tx.delete(categories).where(eq(categories.id, id)).run();
    });
    return {
      outcome: "deleted",
      transactionCount: used.transactionCount,
      ruleCount: used.ruleCount,
    };
  }

  if (
    used.transactionCount > 0 ||
    used.ruleCount > 0 ||
    used.childCount > 0 ||
    used.budgetCount > 0
  ) {
    db.transaction((tx) => {
      tx.update(categories)
        .set({ active: false, updatedAt: new Date().toISOString() })
        .where(inArray(categories.id, [id, ...childIds(tx, id)]))
        .run();
    });
    return {
      outcome: "archived",
      transactionCount: used.transactionCount,
      ruleCount: used.ruleCount,
    };
  }
  db.delete(categories).where(eq(categories.id, id)).run();
  return { outcome: "deleted", transactionCount: 0, ruleCount: 0 };
}

function childIds(db: Pick<AppDb, "select">, parentId: number): number[] {
  return db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, parentId))
    .all()
    .map((row) => row.id);
}

// ---- Built-in starting set --------------------------------------------------------------

const DEFAULT_CATEGORIES: Array<[name: string, color: string]> = [
  ["Groceries", "#16a34a"],
  ["Dining Out", "#ea580c"],
  ["Rent & Utilities", "#2563eb"],
  ["Transportation", "#0891b2"],
  ["Shopping", "#9333ea"],
  ["Entertainment", "#db2777"],
  ["Health & Fitness", "#dc2626"],
  ["Travel", "#0ea5e9"],
  ["Home", "#ca8a04"],
  ["Personal Care", "#c026d3"],
  ["Income", "#15803d"],
  ["Transfers", "#64748b"],
  ["Loan Payments", "#7c3aed"],
  ["Fees & Interest", "#b45309"],
  ["Other", "#6b7280"],
];

/**
 * Rules that turn the bank's own categories into these. They are ordinary rules: the user can
 * edit, disable, reorder, or delete them. More specific ones come first.
 */
const DEFAULT_RULES: Array<[plaidCategory: string, category: string]> = [
  ["FOOD_AND_DRINK_GROCERIES", "Groceries"],
  ["FOOD_AND_DRINK", "Dining Out"],
  ["RENT_AND_UTILITIES", "Rent & Utilities"],
  ["TRANSPORTATION", "Transportation"],
  ["GENERAL_MERCHANDISE", "Shopping"],
  ["ENTERTAINMENT", "Entertainment"],
  ["MEDICAL", "Health & Fitness"],
  ["TRAVEL", "Travel"],
  ["HOME_IMPROVEMENT", "Home"],
  ["PERSONAL_CARE", "Personal Care"],
  ["INCOME", "Income"],
  ["TRANSFER_IN", "Transfers"],
  ["TRANSFER_OUT", "Transfers"],
  ["LOAN_PAYMENTS", "Loan Payments"],
  ["BANK_FEES", "Fees & Interest"],
];

const SEEDED_KEY = "defaults_seeded_v1";

/**
 * Creates the starting categories and rules the first time only, so deleting them later never
 * brings them back. Existing transactions are categorized with the new rules. Returns whether
 * anything was created.
 */
export function seedDefaults(db: AppDb): boolean {
  if (db.select().from(appSettings).where(eq(appSettings.key, SEEDED_KEY)).get()) return false;
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const ids = new Map<string, number>();
    for (const [name, color] of DEFAULT_CATEGORIES) {
      const row = tx
        .insert(categories)
        .values({ name, color, parentId: null, active: true, createdAt: now, updatedAt: now })
        .returning({ id: categories.id })
        .get();
      ids.set(name, row.id);
    }
    DEFAULT_RULES.forEach(([plaidCategory, category], index) => {
      tx.insert(transactionRules)
        .values({
          name: `Bank category ${plaidCategory} → ${category}`,
          field: "plaid_category",
          operator: "equals",
          matchValue: plaidCategory,
          categoryId: ids.get(category)!,
          // Far below anything a user adds, which always goes on top.
          priority: 1000 + index * 10,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    tx.insert(appSettings).values({ key: SEEDED_KEY, value: "true", updatedAt: now }).run();
    applyRules(tx);
  });
  return true;
}
