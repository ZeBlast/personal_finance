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
import { applyRules, DINING_SPLIT_KEY } from "./rule.service.js";

export const NAME_MAX = 60;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface CategoryDto {
  id: number;
  name: string;
  parentId: number | null;
  color: string | null;
  active: boolean;
  /** How money coming in under it counts: taxable income, a refund, or the usual rules (null). */
  incomeTreatment: IncomeTreatment | null;
  transactionCount: number;
  ruleCount: number;
}

export const INCOME_TREATMENTS = ["income", "refund"] as const;
export type IncomeTreatment = (typeof INCOME_TREATMENTS)[number];
const treatmentOf = (v: string | null): IncomeTreatment | null =>
  v === "income" || v === "refund" ? v : null;

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
    incomeTreatment: treatmentOf(row.incomeTreatment),
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
    incomeTreatment: treatmentOf(row.incomeTreatment),
    transactionCount: used.transactionCount,
    ruleCount: used.ruleCount,
  };
}

export function createCategory(
  db: AppDb,
  input: {
    name: string;
    parentId?: number | null | undefined;
    color?: string | null | undefined;
    incomeTreatment?: IncomeTreatment | null | undefined;
  },
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
      incomeTreatment: input.incomeTreatment ?? null,
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
    incomeTreatment?: IncomeTreatment | null | undefined;
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
        ...(patch.incomeTreatment === undefined ? {} : { incomeTreatment: patch.incomeTreatment }),
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

const ADDITIONS_KEY = "defaults_gas_streaming_v1";

/**
 * More starting categories added after the first ones: Gas, and Streaming (TV, movies, and music
 * services). Each comes with ordinary rules, like the others.
 */
const ADDED_CATEGORIES: Array<{
  name: string;
  color: string;
  /** The generic default rule these should sit just before, so they win over it. */
  before: string;
  rules: Array<{
    field: "plaid_category" | "merchant";
    operator: "equals" | "contains";
    value: string;
  }>;
}> = [
  {
    name: "Gas",
    color: "#d97706",
    before: "TRANSPORTATION",
    rules: [{ field: "plaid_category", operator: "equals", value: "TRANSPORTATION_GAS" }],
  },
  {
    name: "Streaming",
    color: "#8b5cf6",
    before: "ENTERTAINMENT",
    rules: [
      { field: "plaid_category", operator: "equals", value: "ENTERTAINMENT_TV_AND_MOVIES" },
      { field: "plaid_category", operator: "equals", value: "ENTERTAINMENT_MUSIC_AND_AUDIO" },
      { field: "merchant", operator: "contains", value: "netflix" },
      { field: "merchant", operator: "contains", value: "hulu" },
      { field: "merchant", operator: "contains", value: "spotify" },
      { field: "merchant", operator: "contains", value: "disney+" },
      { field: "merchant", operator: "contains", value: "youtube premium" },
      { field: "merchant", operator: "contains", value: "apple music" },
    ],
  },
];

export interface StarterAdditionsResult {
  categoriesCreated: number;
  rulesCreated: number;
  /** Past transactions whose category changed because of the new rules. */
  recategorized: number;
}

/**
 * Adds the Gas and Streaming categories and their rules, once, to a database that already has the
 * original starting set, and puts past transactions into them. Only transactions the user has not
 * categorized by hand move. A category with the same name that is already there is used as it is,
 * and deleting these afterwards does not bring them back.
 */
export function ensureStarterAdditions(db: AppDb): StarterAdditionsResult | null {
  if (db.select().from(appSettings).where(eq(appSettings.key, ADDITIONS_KEY)).get()) return null;
  const now = new Date().toISOString();
  const result: StarterAdditionsResult = {
    categoriesCreated: 0,
    rulesCreated: 0,
    recategorized: 0,
  };

  db.transaction((tx) => {
    for (const added of ADDED_CATEGORIES) {
      let category = tx
        .select({ id: categories.id })
        .from(categories)
        .where(sql`lower(${categories.name}) = ${added.name.toLowerCase()}`)
        .get();
      if (!category) {
        category = tx
          .insert(categories)
          .values({
            name: added.name,
            color: added.color,
            parentId: null,
            active: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: categories.id })
          .get();
        result.categoriesCreated += 1;
      }

      // Just ahead of the broad default rule for this area, so the specific one wins.
      const generic = tx
        .select({ priority: transactionRules.priority })
        .from(transactionRules)
        .where(
          sql`${transactionRules.matchValue} = ${added.before} and ${transactionRules.field} = 'plaid_category'`,
        )
        .orderBy(asc(transactionRules.priority))
        .get();
      const base = (generic?.priority ?? 1000) - added.rules.length - 1;
      added.rules.forEach((rule, index) => {
        const name =
          rule.field === "plaid_category"
            ? `Bank category ${rule.value} → ${added.name}`
            : `Merchant contains "${rule.value}" → ${added.name}`;
        const exists = tx
          .select({ id: transactionRules.id })
          .from(transactionRules)
          .where(eq(transactionRules.name, name))
          .get();
        if (exists) return;
        tx.insert(transactionRules)
          .values({
            name,
            field: rule.field,
            operator: rule.operator,
            matchValue: rule.value,
            categoryId: category!.id,
            priority: base + index,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        result.rulesCreated += 1;
      });
    }
    result.recategorized = applyRules(tx).changed;
    tx.insert(appSettings).values({ key: ADDITIONS_KEY, value: "true", updatedAt: now }).run();
  });
  return result;
}

const DINING_SPLIT_DONE = "defaults_dining_split_v1";

/**
 * Splits food and drink by how it was bought, once: a "Food & Drink" category keeps online orders
 * (delivery apps, ordering ahead), and "Dining Out" becomes its subcategory for purchases made in
 * person. The bank-category rule for food and drink now points at Food & Drink, and the rules
 * engine moves each purchase to the right one of the two from its online flag. Past transactions
 * the user did not categorize by hand are sorted again. Returns how many moved, or null if done.
 */
export function ensureDiningSplit(db: AppDb): number | null {
  if (db.select().from(appSettings).where(eq(appSettings.key, DINING_SPLIT_DONE)).get()) {
    return null;
  }
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const byName = (name: string) =>
      tx
        .select({ id: categories.id, parentId: categories.parentId })
        .from(categories)
        .where(sql`lower(${categories.name}) = ${name.toLowerCase()}`)
        .get();
    const create = (name: string, color: string, parentId: number | null) =>
      tx
        .insert(categories)
        .values({ name, color, parentId, active: true, createdAt: now, updatedAt: now })
        .returning({ id: categories.id, parentId: categories.parentId })
        .get();

    const food = byName("Food & Drink") ?? create("Food & Drink", "#f97316", null);
    let dining = byName("Dining Out");
    if (!dining) dining = create("Dining Out", "#ea580c", food.id);
    else if (dining.parentId !== food.id) {
      // Only a top-level category with no subcategories of its own can move under Food & Drink.
      const hasChildren = childIds(tx, dining.id).length > 0;
      if (dining.parentId === null && !hasChildren) {
        tx.update(categories)
          .set({ parentId: food.id, updatedAt: now })
          .where(eq(categories.id, dining.id))
          .run();
      } else {
        dining = create("Dining Out (in person)", "#ea580c", food.id);
      }
    }

    // The broad bank-category rule for food and drink now files into Food & Drink.
    tx.update(transactionRules)
      .set({
        categoryId: food.id,
        name: "Bank category FOOD_AND_DRINK → Food & Drink",
        updatedAt: now,
      })
      .where(
        sql`${transactionRules.field} = 'plaid_category' and ${transactionRules.matchValue} = 'FOOD_AND_DRINK' and ${transactionRules.categoryId} = ${dining.id}`,
      )
      .run();
    tx.insert(appSettings)
      .values({
        key: DINING_SPLIT_KEY,
        value: JSON.stringify({ parentId: food.id, childId: dining.id }),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: JSON.stringify({ parentId: food.id, childId: dining.id }), updatedAt: now },
      })
      .run();
    const moved = applyRules(tx).changed;
    tx.insert(appSettings).values({ key: DINING_SPLIT_DONE, value: "true", updatedAt: now }).run();
    return moved;
  });
}

const TRANSFER_KINDS_DONE = "defaults_transfer_credit_refund_v1";

/**
 * Adds "Credit" and "Refund" under Transfers, once. Money in under Credit counts as taxable income;
 * money in under Refund lowers spending and never counts as income. A Transfers category is made if
 * there is none, and existing categories with those names are reused (and given the setting).
 */
export function ensureTransferSubcategories(db: AppDb): boolean {
  if (db.select().from(appSettings).where(eq(appSettings.key, TRANSFER_KINDS_DONE)).get())
    return false;
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const top = (name: string) =>
      tx
        .select({ id: categories.id })
        .from(categories)
        .where(
          sql`lower(${categories.name}) = ${name.toLowerCase()} and ${categories.parentId} is null`,
        )
        .get();
    const parent =
      top("Transfers") ??
      tx
        .insert(categories)
        .values({
          name: "Transfers",
          color: "#64748b",
          parentId: null,
          active: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: categories.id })
        .get();
    for (const [name, color, treatment] of [
      ["Credit", "#0d9488", "income"],
      ["Refund", "#a3a3a3", "refund"],
    ] as const) {
      const existing = tx
        .select({ id: categories.id })
        .from(categories)
        .where(
          sql`lower(${categories.name}) = ${name.toLowerCase()} and ${categories.parentId} = ${parent.id}`,
        )
        .get();
      if (existing) {
        tx.update(categories)
          .set({ incomeTreatment: treatment, updatedAt: now })
          .where(eq(categories.id, existing.id))
          .run();
      } else {
        tx.insert(categories)
          .values({
            name,
            color,
            parentId: parent.id,
            active: true,
            incomeTreatment: treatment,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    }
    tx.insert(appSettings)
      .values({ key: TRANSFER_KINDS_DONE, value: "true", updatedAt: now })
      .run();
  });
  return true;
}
