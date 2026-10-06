import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { categories, transactionRules, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";

export const RULE_FIELDS = ["merchant", "name", "recipient", "plaid_category"] as const;
export const RULE_OPERATORS = ["equals", "contains", "starts_with"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleOperator = (typeof RULE_OPERATORS)[number];

type Reader = Pick<AppDb, "select">;
type Writer = Pick<AppDb, "select" | "update">;

/** What a rule needs to know about a transaction. Values are the ones the user sees. */
export interface RuleSubject {
  merchant: string;
  name: string;
  recipient: string | null;
  plaidPrimary: string | null;
  plaidDetailed: string | null;
}

export interface RuleLike {
  field: RuleField;
  operator: RuleOperator;
  matchValue: string;
}

const norm = (text: string): string => text.trim().toLowerCase();

/** Every value of the chosen field a rule may be compared against. */
function candidates(field: RuleField, subject: RuleSubject): string[] {
  switch (field) {
    case "merchant":
      return [subject.merchant];
    case "name":
      return [subject.name];
    case "recipient":
      return subject.recipient ? [subject.recipient] : [];
    case "plaid_category":
      // The bank's category matches at either level: "FOOD_AND_DRINK" or "FOOD_AND_DRINK_GROCERIES".
      return [subject.plaidDetailed, subject.plaidPrimary].filter((v): v is string => !!v);
  }
}

/** Case-insensitive match. An empty rule value never matches anything. */
export function ruleMatches(rule: RuleLike, subject: RuleSubject): boolean {
  const wanted = norm(rule.matchValue);
  if (wanted === "") return false;
  return candidates(rule.field, subject).some((value) => {
    const have = norm(value);
    switch (rule.operator) {
      case "equals":
        return have === wanted;
      case "contains":
        return have.includes(wanted);
      case "starts_with":
        return have.startsWith(wanted);
    }
  });
}

export interface RuleRow extends RuleLike {
  id: number;
  name: string;
  categoryId: number;
  priority: number;
  enabled: boolean;
}

/** Enabled rules whose category is active, in the order they are tried. */
export function activeRules(db: Reader): RuleRow[] {
  return db
    .select({
      id: transactionRules.id,
      name: transactionRules.name,
      field: transactionRules.field,
      operator: transactionRules.operator,
      matchValue: transactionRules.matchValue,
      categoryId: transactionRules.categoryId,
      priority: transactionRules.priority,
      enabled: transactionRules.enabled,
    })
    .from(transactionRules)
    .innerJoin(categories, eq(transactionRules.categoryId, categories.id))
    .where(and(eq(transactionRules.enabled, true), eq(categories.active, true)))
    .orderBy(asc(transactionRules.priority), asc(transactionRules.id))
    .all() as RuleRow[];
}

/** The first rule, in order, that matches; this is what makes categorizing deterministic. */
export function firstMatch(rules: RuleRow[], subject: RuleSubject): RuleRow | null {
  return rules.find((rule) => ruleMatches(rule, subject)) ?? null;
}

const subjectColumns = {
  id: transactions.id,
  name: transactions.name,
  merchantName: transactions.merchantName,
  merchantNameUser: transactions.merchantNameUser,
  recipient: transactions.recipient,
  recipientUser: transactions.recipientUser,
  plaidPrimary: transactions.plaidCategoryPrimary,
  plaidDetailed: transactions.plaidCategoryDetailed,
  categoryId: transactions.categoryId,
  categorySource: transactions.categorySource,
  categoryRuleId: transactions.categoryRuleId,
};

function toSubject(row: {
  name: string;
  merchantName: string | null;
  merchantNameUser: string | null;
  recipient: string | null;
  recipientUser: string | null;
  plaidPrimary: string | null;
  plaidDetailed: string | null;
}): RuleSubject {
  return {
    merchant: row.merchantNameUser?.trim() || row.merchantName || row.name,
    name: row.name,
    recipient: row.recipientUser?.trim() || row.recipient,
    plaidPrimary: row.plaidPrimary,
    plaidDetailed: row.plaidDetailed,
  };
}

export interface ApplyResult {
  /** Transactions looked at (those the user has not categorized by hand). */
  examined: number;
  /** Transactions whose category changed. */
  changed: number;
}

/**
 * Runs the rules over transactions and stores the result.
 *
 * Never touches a transaction the user categorized by hand. For all others the outcome is exactly
 * what the first matching rule says: a transaction whose rule no longer matches goes back to
 * uncategorized rather than keeping a stale category.
 */
export function applyRules(db: Writer, ids?: number[]): ApplyResult {
  const rules = activeRules(db);
  const notManual = or(
    isNull(transactions.categorySource),
    ne(transactions.categorySource, "manual"),
  );
  const rows =
    ids === undefined
      ? db.select(subjectColumns).from(transactions).where(notManual).all()
      : ids.length === 0
        ? []
        : db
            .select(subjectColumns)
            .from(transactions)
            .where(and(inArray(transactions.id, ids), notManual))
            .all();

  let changed = 0;
  for (const row of rows) {
    const match = firstMatch(rules, toSubject(row));
    const nextCategory = match?.categoryId ?? null;
    const nextRule = match?.id ?? null;
    const nextSource = match ? "rule" : null;
    if (
      row.categoryId === nextCategory &&
      row.categoryRuleId === nextRule &&
      row.categorySource === nextSource
    ) {
      continue;
    }
    db.update(transactions)
      .set({ categoryId: nextCategory, categoryRuleId: nextRule, categorySource: nextSource })
      .where(eq(transactions.id, row.id))
      .run();
    changed += 1;
  }
  return { examined: rows.length, changed };
}

export interface RuleDto {
  id: number;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  matchValue: string;
  categoryId: number;
  categoryName: string;
  categoryActive: boolean;
  priority: number;
  enabled: boolean;
}

const dtoColumns = {
  id: transactionRules.id,
  name: transactionRules.name,
  field: transactionRules.field,
  operator: transactionRules.operator,
  matchValue: transactionRules.matchValue,
  categoryId: transactionRules.categoryId,
  categoryName: categories.name,
  categoryActive: categories.active,
  priority: transactionRules.priority,
  enabled: transactionRules.enabled,
};

export function listRules(db: AppDb): RuleDto[] {
  return db
    .select(dtoColumns)
    .from(transactionRules)
    .innerJoin(categories, eq(transactionRules.categoryId, categories.id))
    .orderBy(asc(transactionRules.priority), asc(transactionRules.id))
    .all() as RuleDto[];
}

function getRule(db: AppDb, id: number): RuleDto {
  const row = db
    .select(dtoColumns)
    .from(transactionRules)
    .innerJoin(categories, eq(transactionRules.categoryId, categories.id))
    .where(eq(transactionRules.id, id))
    .get();
  if (!row) throw notFound("That rule");
  return row as RuleDto;
}

function requireActiveCategory(db: AppDb, categoryId: number): void {
  const category = db
    .select({ active: categories.active })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .get();
  if (!category) throw new AppError(400, "unknown_category", "That category does not exist.");
  if (!category.active) {
    throw new AppError(400, "inactive_category", "That category is archived. Restore it first.");
  }
}

export interface RuleInput {
  name: string;
  field: RuleField;
  operator: RuleOperator;
  matchValue: string;
  categoryId: number;
  enabled?: boolean | undefined;
}

export function createRule(db: AppDb, input: RuleInput): RuleDto {
  requireActiveCategory(db, input.categoryId);
  const now = new Date().toISOString();
  const lowest = db
    .select({ priority: transactionRules.priority })
    .from(transactionRules)
    .orderBy(asc(transactionRules.priority))
    .get();
  // A new rule goes to the top, so the rule you just wrote wins over older and built-in ones.
  const priority = lowest ? lowest.priority - 10 : 0;
  const created = db
    .insert(transactionRules)
    .values({
      name: input.name,
      field: input.field,
      operator: input.operator,
      matchValue: input.matchValue,
      categoryId: input.categoryId,
      priority,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: transactionRules.id })
    .get();
  return getRule(db, created.id);
}

export function updateRule(db: AppDb, id: number, patch: Partial<RuleInput>): RuleDto {
  getRule(db, id);
  if (patch.categoryId !== undefined) requireActiveCategory(db, patch.categoryId);
  db.update(transactionRules)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(transactionRules.id, id))
    .run();
  return getRule(db, id);
}

/**
 * Deletes a rule. Transactions it had categorized are re-evaluated, so another rule may now
 * apply, and otherwise they become uncategorized (nothing keeps pointing at the deleted rule).
 */
export function deleteRule(db: AppDb, id: number): void {
  getRule(db, id);
  db.transaction((tx) => {
    const affected = tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.categoryRuleId, id))
      .all()
      .map((row) => row.id);
    tx.update(transactions)
      .set({ categoryId: null, categoryRuleId: null, categorySource: null })
      .where(eq(transactions.categoryRuleId, id))
      .run();
    tx.delete(transactionRules).where(eq(transactionRules.id, id)).run();
    applyRules(tx, affected);
  });
}

/** Sets the order rules are tried in. `orderedIds` must contain every rule exactly once. */
export function reorderRules(db: AppDb, orderedIds: number[]): RuleDto[] {
  const existing = db.select({ id: transactionRules.id }).from(transactionRules).all();
  const wanted = new Set(orderedIds);
  if (
    wanted.size !== orderedIds.length ||
    orderedIds.length !== existing.length ||
    !existing.every((row) => wanted.has(row.id))
  ) {
    throw new AppError(400, "invalid_order", "The new order must list every rule exactly once.");
  }
  db.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(transactionRules)
        .set({ priority: (index + 1) * 10 })
        .where(eq(transactionRules.id, id))
        .run();
    });
  });
  return listRules(db);
}

export interface RulePreview {
  matchCount: number;
  sample: Array<{ id: number; date: string; merchant: string; amountMinor: number }>;
}

/** How many existing transactions a rule would match (any category state), with a few examples. */
export function previewRule(db: AppDb, rule: RuleLike): RulePreview {
  const rows = db
    .select({
      ...subjectColumns,
      date: transactions.date,
      amountMinor: transactions.amountMinor,
    })
    .from(transactions)
    .all();
  const matches = rows
    .filter((row) => ruleMatches(rule, toSubject(row)))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return {
    matchCount: matches.length,
    sample: matches.slice(0, 5).map((row) => ({
      id: row.id,
      date: row.date,
      merchant: toSubject(row).merchant,
      amountMinor: row.amountMinor,
    })),
  };
}
