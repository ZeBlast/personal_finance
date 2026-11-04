import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  appSettings,
  categories,
  categoryChangeBatches,
  categoryChangeItems,
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
type Writer = Pick<AppDb, "select" | "update" | "insert">;

/** What a rule needs to know about a transaction. Values are the ones the user sees. */
export interface RuleSubject {
  /** `YYYY-MM-DD`, compared with a rule's `appliesFrom`. */
  date: string;
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
  /** `YYYY-MM-DD`: the rule never matches a transaction dated before this day. */
  appliesFrom?: string | null | undefined;
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
  if (rule.appliesFrom && subject.date < rule.appliesFrom) return false;
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
      appliesFrom: transactionRules.appliesFrom,
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
  date: transactions.date,
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
  date: string;
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
    date: row.date,
    merchant: row.merchantNameUser?.trim() || row.merchantName || row.name,
    name: row.name,
    recipient: row.recipientUser?.trim() || row.recipient,
    sender: row.senderUser?.trim() || row.sender,
    plaidPrimary: row.plaidPrimary,
    plaidDetailed: row.plaidDetailed,
    amountMinor: row.amountMinor,
  };
}

/** Asks `applyRules` to keep its changes as a batch that can be undone. */
export interface BatchRecord {
  kind: "rule_saved" | "rules_applied";
  ruleId: number | null;
  label: string;
  now: string;
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
 * uncategorized rather than keeping a stale category. With `record`, the changes are also saved
 * as a batch (when there is at least one) so they can be undone.
 */
export function applyRules(
  db: Writer,
  ids?: number[],
  record?: BatchRecord,
): ApplyResult & { batchId: number | null } {
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
  const items: Array<Omit<typeof categoryChangeItems.$inferInsert, "batchId">> = [];
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
    items.push({
      transactionId: row.id,
      fromCategoryId: row.categoryId,
      fromRuleId: row.categoryRuleId,
      fromSource: row.categorySource,
      toCategoryId: nextCategory,
      toRuleId: nextRule,
      toSource: nextSource,
    });
  }
  syncCategoryTransfers(db);
  let batchId: number | null = null;
  if (record && items.length > 0) {
    const created = db
      .insert(categoryChangeBatches)
      .values({
        kind: record.kind,
        ruleId: record.ruleId,
        label: record.label,
        changeCount: items.length,
        createdAt: record.now,
      })
      .returning({ id: categoryChangeBatches.id })
      .get();
    batchId = created.id;
    for (let i = 0; i < items.length; i += 500) {
      db.insert(categoryChangeItems)
        .values(items.slice(i, i + 500).map((item) => ({ ...item, batchId: created.id })))
        .run();
    }
  }
  return { examined: rows.length, changed, batchId };
}

export interface RuleDto {
  id: number;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  matchValue: string;
  direction: RuleDirection | null;
  appliesFrom: string | null;
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
  appliesFrom: transactionRules.appliesFrom,
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
  /** `YYYY-MM-DD`, or null for every date. */
  appliesFrom?: string | null | undefined;
  categoryId: number;
  enabled?: boolean | undefined;
}

/**
 * Saves a rule. `scope: "new"` makes it file only transactions from today on; `"all"` also files
 * the past straight away, as a batch that can be undone. Without a scope nothing is applied.
 */
export function createRule(
  db: AppDb,
  input: Omit<RuleInput, "appliesFrom"> & { scope?: "new" | "all" | undefined },
): RuleDto {
  requireActiveCategory(db, input.categoryId);
  const now = new Date().toISOString();
  const id = db.transaction((tx) => {
    const lowest = tx
      .select({ priority: transactionRules.priority })
      .from(transactionRules)
      .orderBy(asc(transactionRules.priority))
      .get();
    // A new rule goes to the top, so the rule you just wrote wins over older and built-in ones.
    const priority = lowest ? lowest.priority - 10 : 0;
    const created = tx
      .insert(transactionRules)
      .values({
        name: input.name,
        field: input.field,
        operator: input.operator,
        matchValue: input.matchValue,
        direction: input.direction ?? null,
        appliesFrom: input.scope === "new" ? now.slice(0, 10) : null,
        categoryId: input.categoryId,
        priority,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: transactionRules.id })
      .get();
    if (input.scope === "all") {
      applyRules(tx, undefined, {
        kind: "rule_saved",
        ruleId: created.id,
        label: `Saved rule "${input.name}"`,
        now,
      });
    }
    return created.id;
  });
  return getRule(db, id);
}

/** Changes a rule. With `apply`, the changed rule is also run over the past, as a batch. */
export function updateRule(
  db: AppDb,
  id: number,
  patch: Partial<RuleInput> & { apply?: boolean | undefined },
): RuleDto {
  const before = getRule(db, id);
  if (patch.categoryId !== undefined) requireActiveCategory(db, patch.categoryId);
  const { apply, ...changes } = patch;
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(transactionRules)
      .set({ ...changes, updatedAt: now })
      .where(eq(transactionRules.id, id))
      .run();
    if (apply) {
      applyRules(tx, undefined, {
        kind: "rule_saved",
        ruleId: id,
        label: `Changed rule "${changes.name ?? before.name}"`,
        now,
      });
    }
  });
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
  /** One page of those changes, newest first. */
  changes?: RuleChange[];
  /** The net money each category gains (+) or loses (-) from those changes, largest first. */
  totals?: Array<{
    categoryId: number | null;
    name: string | null;
    changeMinor: number;
    count: number;
  }>;
  /** Matching transactions whose category was chosen by hand, so stay as they are. */
  manualCount?: number;
}

const PREVIEW_PAGE = 50;
const PREVIEW_MAX_PAGE = 200;

/**
 * How many existing transactions a rule would match (any category state), with a few examples.
 * Given the category it files into (and, when editing, which rule it is), also what saving it
 * would really change: each transaction's category with the rule in its place among the others
 * (a new rule goes to the top), compared with what it has now. `scope` says whether the rule would
 * cover only transactions from `today` on ("new") or every date ("all"); when left out, an edited
 * rule keeps the start day it has and a new one covers every date.
 */
export function previewRule(
  db: AppDb,
  rule: RuleLike & {
    categoryId?: number | undefined;
    ruleId?: number | undefined;
    scope?: "new" | "all" | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  },
  today: string = todayIso(),
): RulePreview {
  const rows = db
    .select({
      ...subjectColumns,
    })
    .from(transactions)
    .all();
  const existing =
    rule.ruleId === undefined ? undefined : activeRules(db).find((r) => r.id === rule.ruleId);
  const appliesFrom =
    rule.scope === "new" ? today : rule.scope === "all" ? null : (existing?.appliesFrom ?? null);
  const effective = { ...rule, appliesFrom };
  const newestFirst = (a: { date: string; id: number }, b: { date: string; id: number }) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id;
  const matches = rows.filter((row) => ruleMatches(effective, toSubject(row))).sort(newestFirst);
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
  const candidate: RuleRow = {
    id: rule.ruleId ?? -1,
    name: "preview",
    field: rule.field,
    operator: rule.operator,
    matchValue: rule.matchValue,
    direction: rule.direction ?? null,
    appliesFrom,
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
  const nameOf = (id: number | null): string | null =>
    id === null ? null : (names.get(id) ?? null);
  const changes: RuleChange[] = [];
  const totals = new Map<number | null, { changeMinor: number; count: number }>();
  const bump = (id: number | null, amount: number) => {
    const entry = totals.get(id) ?? { changeMinor: 0, count: 0 };
    entry.changeMinor += amount;
    entry.count += 1;
    totals.set(id, entry);
  };
  let manualCount = 0;
  for (const row of [...rows].sort(newestFirst)) {
    const subject = toSubject(row);
    const matchesNow = ruleMatches(effective, subject);
    const touches = matchesNow || (rule.ruleId !== undefined && row.categoryRuleId === rule.ruleId);
    if (!touches) continue;
    if (row.categorySource === "manual") {
      if (matchesNow) manualCount += 1;
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
      from: nameOf(row.categoryId),
      to: nameOf(next),
    });
    bump(next, row.amountMinor);
    bump(row.categoryId, -row.amountMinor);
  }
  const offset = Math.max(0, rule.offset ?? 0);
  const limit = Math.min(PREVIEW_MAX_PAGE, Math.max(1, rule.limit ?? PREVIEW_PAGE));
  return {
    ...preview,
    changeCount: changes.length,
    changes: changes.slice(offset, offset + limit),
    totals: [...totals]
      .map(([categoryId, t]) => ({ categoryId, name: nameOf(categoryId), ...t }))
      .sort(
        (a, b) =>
          Math.abs(b.changeMinor) - Math.abs(a.changeMinor) || b.changeMinor - a.changeMinor,
      ),
    manualCount,
  };
}

// ---- Change batches: seeing what a rule did, and undoing it -------------------------------------

export interface ChangeBatchDto {
  id: number;
  kind: "rule_saved" | "rules_applied";
  label: string;
  ruleId: number | null;
  changeCount: number;
  createdAt: string;
  undoneAt: string | null;
}

/** The most recent batches, newest first (undone ones included, marked). */
export function listBatches(db: Reader, limit = 10): ChangeBatchDto[] {
  return db
    .select({
      id: categoryChangeBatches.id,
      kind: categoryChangeBatches.kind,
      label: categoryChangeBatches.label,
      ruleId: categoryChangeBatches.ruleId,
      changeCount: categoryChangeBatches.changeCount,
      createdAt: categoryChangeBatches.createdAt,
      undoneAt: categoryChangeBatches.undoneAt,
    })
    .from(categoryChangeBatches)
    .orderBy(desc(categoryChangeBatches.id))
    .limit(limit)
    .all() as ChangeBatchDto[];
}

/**
 * Puts a batch's transactions back as they were. A transaction is only restored if it still has
 * exactly the category the batch gave it; one changed since (by hand, or by a newer batch) keeps
 * its newer category and is reported in `kept`.
 */
export function undoBatch(
  db: AppDb,
  id: number,
  now: string = new Date().toISOString(),
): {
  restored: number;
  kept: Array<{ id: number; date: string; merchant: string; category: string | null }>;
} {
  const batch = db
    .select({ undoneAt: categoryChangeBatches.undoneAt })
    .from(categoryChangeBatches)
    .where(eq(categoryChangeBatches.id, id))
    .get();
  if (!batch) throw notFound("That change");
  if (batch.undoneAt !== null) {
    throw new AppError(409, "already_undone", "That change has already been undone.");
  }
  return db.transaction((tx) => {
    const items = tx
      .select({
        item: categoryChangeItems,
        categoryId: transactions.categoryId,
        categoryRuleId: transactions.categoryRuleId,
        categorySource: transactions.categorySource,
        date: transactions.date,
        name: transactions.name,
        merchantName: transactions.merchantName,
        merchantNameUser: transactions.merchantNameUser,
      })
      .from(categoryChangeItems)
      .innerJoin(transactions, eq(categoryChangeItems.transactionId, transactions.id))
      .where(eq(categoryChangeItems.batchId, id))
      .all();
    const liveRules = new Set(
      tx
        .select({ id: transactionRules.id })
        .from(transactionRules)
        .all()
        .map((r) => r.id),
    );
    const names = new Map(
      tx
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .all()
        .map((c) => [c.id, c.name]),
    );
    let restored = 0;
    const kept: Array<{ id: number; date: string; merchant: string; category: string | null }> = [];
    for (const row of items) {
      const { item } = row;
      const unchanged =
        row.categoryId === item.toCategoryId &&
        row.categoryRuleId === item.toRuleId &&
        row.categorySource === item.toSource;
      if (!unchanged) {
        kept.push({
          id: item.transactionId,
          date: row.date,
          merchant: row.merchantNameUser?.trim() || row.merchantName || row.name,
          category: row.categoryId === null ? null : (names.get(row.categoryId) ?? null),
        });
        continue;
      }
      tx.update(transactions)
        .set({
          categoryId: item.fromCategoryId,
          // A rule deleted since would leave a dangling pointer.
          categoryRuleId:
            item.fromRuleId !== null && liveRules.has(item.fromRuleId) ? item.fromRuleId : null,
          categorySource: item.fromSource,
        })
        .where(eq(transactions.id, item.transactionId))
        .run();
      restored += 1;
    }
    syncCategoryTransfers(tx);
    tx.update(categoryChangeBatches)
      .set({ undoneAt: now })
      .where(eq(categoryChangeBatches.id, id))
      .run();
    return { restored, kept };
  });
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
