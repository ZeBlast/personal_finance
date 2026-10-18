import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  appSettings,
  categories,
  transactionRules,
  transactions,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { syncCategoryTransfers } from "./transfer.service.js";
import { AppError, notFound } from "../utils/errors.js";
import { merchantKey } from "../utils/merchant.js";

export const RULE_FIELDS = ["merchant", "name", "recipient", "sender", "plaid_category"] as const;
export const RULE_OPERATORS = ["equals", "contains", "starts_with", "same_merchant"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleOperator = (typeof RULE_OPERATORS)[number];
/** Which way the money moves for a rule to apply: `in`, `out`, or (null) either. */
export const RULE_DIRECTIONS = ["in", "out"] as const;
export type RuleDirection = (typeof RULE_DIRECTIONS)[number];

type Reader = Pick<AppDb, "select">;
type Writer = Pick<AppDb, "select" | "update">;

/** What a rule needs to know about a transaction. Values are the ones the user sees. */
export interface RuleSubject {
  merchant: string;
  name: string;
  recipient: string | null;
  sender: string | null;
  plaidPrimary: string | null;
  plaidDetailed: string | null;
  /** Cents, positive is money out; when unknown, a direction-limited rule never matches. */
  amountMinor?: number | undefined;
}

export interface RuleLike {
  field: RuleField;
  operator: RuleOperator;
  matchValue: string;
  direction?: RuleDirection | null | undefined;
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
    case "sender":
      return subject.sender ? [subject.sender] : [];
    case "plaid_category":
      // The bank's category matches at either level: "FOOD_AND_DRINK" or "FOOD_AND_DRINK_GROCERIES".
      return [subject.plaidDetailed, subject.plaidPrimary].filter((v): v is string => !!v);
  }
}

/** Case-insensitive match. An empty rule value never matches anything. */
export function ruleMatches(rule: RuleLike, subject: RuleSubject): boolean {
  const wanted = norm(rule.matchValue);
  if (wanted === "") return false;
  const amount = subject.amountMinor ?? 0;
  if (rule.direction === "out" && !(amount > 0)) return false;
  if (rule.direction === "in" && !(amount < 0)) return false;
  if (rule.operator === "same_merchant") {
    // The same place, ignoring case, store numbers and reference ids.
    const key = merchantKey(rule.matchValue);
    return (
      key !== "" && candidates(rule.field, subject).some((value) => merchantKey(value) === key)
    );
  }
  return candidates(rule.field, subject).some((value) => {
    const have = norm(value);
    switch (rule.operator) {
      case "equals":
        return have === wanted;
      case "contains":
        return have.includes(wanted);
      case "starts_with":
        return have.startsWith(wanted);
      case "same_merchant":
        return false; // handled above
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
      direction: transactionRules.direction,
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
  sender: transactions.sender,
  senderUser: transactions.senderUser,
  plaidPrimary: transactions.plaidCategoryPrimary,
  plaidDetailed: transactions.plaidCategoryDetailed,
  amountMinor: transactions.amountMinor,
  categoryId: transactions.categoryId,
  categorySource: transactions.categorySource,
  categoryRuleId: transactions.categoryRuleId,
  onlineUser: transactions.onlineUser,
  paymentChannel: transactions.paymentChannel,
};

// ---- Food & Drink: online stays, in person is Dining Out ----------------------------------------

export const DINING_SPLIT_KEY = "dining_split";

/**
 * The pair of categories split by whether a purchase was online: the parent (Food & Drink) keeps
 * online orders, and its subcategory (Dining Out) takes purchases made in person.
 */
export interface DiningSplit {
  parentId: number;
  childId: number;
}

export function getDiningSplit(db: Pick<AppDb, "select">): DiningSplit | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, DINING_SPLIT_KEY)).get();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as Partial<DiningSplit>;
    return typeof value.parentId === "number" && typeof value.childId === "number"
      ? { parentId: value.parentId, childId: value.childId }
      : null;
  } catch {
    return null;
  }
}

/** Whether a transaction was bought online: the user's call if they made one, else the bank's. */
export function isOnline(row: {
  onlineUser: boolean | null;
  paymentChannel: string | null;
}): boolean {
  return row.onlineUser ?? row.paymentChannel === "online";
}

/** Moves a purchase between Food & Drink (online) and Dining Out (in person); others stay. */
export function splitCategory(
  split: DiningSplit | null,
  categoryId: number | null,
  online: boolean,
): number | null {
  if (!split || categoryId === null) return categoryId;
  if (categoryId === split.parentId && !online) return split.childId;
  if (categoryId === split.childId && online) return split.parentId;
  return categoryId;
}

function toSubject(row: {
  name: string;
  merchantName: string | null;
  merchantNameUser: string | null;
  recipient: string | null;
  recipientUser: string | null;
  sender: string | null;
  senderUser: string | null;
  plaidPrimary: string | null;
  plaidDetailed: string | null;
  amountMinor: number;
}): RuleSubject {
  return {
    merchant: row.merchantNameUser?.trim() || row.merchantName || row.name,
    name: row.name,
    recipient: row.recipientUser?.trim() || row.recipient,
    sender: row.senderUser?.trim() || row.sender,
    plaidPrimary: row.plaidPrimary,
    plaidDetailed: row.plaidDetailed,
    amountMinor: row.amountMinor,
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

  const split = getDiningSplit(db);
  let changed = 0;
  for (const row of rows) {
    const match = firstMatch(rules, toSubject(row));
    const nextCategory = splitCategory(split, match?.categoryId ?? null, isOnline(row));
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
  syncCategoryTransfers(db);
  return { examined: rows.length, changed };
}

export interface RuleDto {
  id: number;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  matchValue: string;
  direction: RuleDirection | null;
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
  direction: transactionRules.direction,
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
  direction?: RuleDirection | null | undefined;
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
      direction: input.direction ?? null,
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

export interface RuleChange {
  id: number;
  date: string;
  merchant: string;
  amountMinor: number;
  from: string | null;
  to: string | null;
}

export interface RulePreview {
  matchCount: number;
  sample: Array<{ id: number; date: string; merchant: string; amountMinor: number }>;
  /**
   * With the rule's category given: what saving it would really change, after the order rules are
   * tried in and the categories chosen by hand (which rules never change).
   */
  changeCount?: number;
  /** A few of those changes, newest first. */
  changes?: RuleChange[];
  /** Matching transactions whose category was chosen by hand, so stay as they are. */
  manualCount?: number;
}

/**
 * How many existing transactions a rule would match (any category state), with a few examples.
 * Given the category it files into (and, when editing, which rule it is), also what saving it
 * would really change: each transaction's category with the rule in its place among the others
 * (a new rule goes to the top), compared with what it has now.
 */
export function previewRule(
  db: AppDb,
  rule: RuleLike & { categoryId?: number | undefined; ruleId?: number | undefined },
): RulePreview {
  const rows = db
    .select({
      ...subjectColumns,
      date: transactions.date,
    })
    .from(transactions)
    .all();
  const newestFirst = (a: { date: string; id: number }, b: { date: string; id: number }) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id;
  const matches = rows.filter((row) => ruleMatches(rule, toSubject(row))).sort(newestFirst);
  const preview: RulePreview = {
    matchCount: matches.length,
    sample: matches.slice(0, 5).map((row) => ({
      id: row.id,
      date: row.date,
      merchant: toSubject(row).merchant,
      amountMinor: row.amountMinor,
    })),
  };
  if (rule.categoryId === undefined) return preview;

  // The rules with this one in its place: replacing itself when edited, on top when new.
  const others = activeRules(db).filter((r) => r.id !== rule.ruleId);
  const existing =
    rule.ruleId === undefined ? undefined : activeRules(db).find((r) => r.id === rule.ruleId);
  const candidate: RuleRow = {
    id: rule.ruleId ?? -1,
    name: "preview",
    field: rule.field,
    operator: rule.operator,
    matchValue: rule.matchValue,
    direction: rule.direction ?? null,
    categoryId: rule.categoryId,
    priority: existing?.priority ?? Math.min(0, ...others.map((r) => r.priority)) - 10,
    enabled: true,
  } as RuleRow;
  const ordered = [...others, candidate].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const split = getDiningSplit(db);
  const names = new Map(
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .all()
      .map((c) => [c.id, c.name]),
  );
  const changes: RuleChange[] = [];
  let manualCount = 0;
  for (const row of [...rows].sort(newestFirst)) {
    const subject = toSubject(row);
    const touches =
      ruleMatches(rule, subject) ||
      (rule.ruleId !== undefined && row.categoryRuleId === rule.ruleId);
    if (!touches) continue;
    if (row.categorySource === "manual") {
      if (ruleMatches(rule, subject)) manualCount += 1;
      continue;
    }
    const match = firstMatch(ordered, subject);
    const next = splitCategory(split, match?.categoryId ?? null, isOnline(row));
    if (next === row.categoryId) continue;
    changes.push({
      id: row.id,
      date: row.date,
      merchant: subject.merchant,
      amountMinor: row.amountMinor,
      from: row.categoryId === null ? null : (names.get(row.categoryId) ?? null),
      to: next === null ? null : (names.get(next) ?? null),
    });
  }
  return {
    ...preview,
    changeCount: changes.length,
    changes: changes.slice(0, 8),
    manualCount,
  };
}
