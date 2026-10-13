import { and, asc, eq, like, sql } from "drizzle-orm";
import { appSettings, categories, transactionRules } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { applyRules, type RuleDirection } from "./rule.service.js";

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

const RULES_V2_DONE = "defaults_rules_direction_v1";

/**
 * Bank categories whose money coming in is not what the category means: a streaming or insurance
 * credit, a parking refund, a home store return. Their rules now apply to money going out only, so
 * those credits are left for the refund and credit rules (and the user).
 */
const OUT_ONLY_BANK_CATEGORIES = [
  "ENTERTAINMENT_TV_AND_MOVIES",
  "GENERAL_SERVICES_INSURANCE",
  "HOME_IMPROVEMENT",
  "TRANSPORTATION_PARKING",
];

/** Generic name rules any user benefits from: the category they file into, and the words. */
const GENERIC_RULES: Array<{
  category: string;
  direction: RuleDirection;
  field: "name" | "merchant";
  values: string[];
}> = [
  // Card and bank credits that give spending back: cashback, statement and streaming credits.
  {
    category: "Reimbursements",
    direction: "in",
    field: "name",
    values: [
      "cash back",
      "cashback",
      "cash reward",
      "statement credit",
      "streaming credit",
      "entertainment credit",
      "paze credit",
    ],
  },
  // Memberships billed like a store purchase.
  {
    category: "Subscriptions",
    direction: "out",
    field: "merchant",
    values: ["walmart+", "uber one", "amazon prime"],
  },
];

export interface RuleImprovementsResult {
  directionsSet: number;
  rulesMoved: number;
  rulesCreated: number;
  recategorized: number;
}

const categoryByName = (tx: Pick<AppDb, "select">, name: string) =>
  tx
    .select({ id: categories.id, active: categories.active })
    .from(categories)
    .where(sql`lower(${categories.name}) = ${name.toLowerCase()}`)
    .get();

/**
 * Improves the starting rules, once:
 *
 * - Rules can now say which way the money moves. The bank-category rules above, and the streaming
 *   service rules, apply to money going out only.
 * - A rule that matches the name or merchant is more specific than one that matches the bank's
 *   category, so every such rule now comes before the bank-category rules (in the same order).
 * - Generic rules file cashback and card credits under Reimbursements, and memberships under
 *   Subscriptions, ahead of the bank-category rules.
 *
 * Rules the user changed keep their direction; categories chosen by hand never move.
 */
export function ensureRuleImprovements(db: AppDb): RuleImprovementsResult | null {
  if (db.select().from(appSettings).where(eq(appSettings.key, RULES_V2_DONE)).get()) return null;
  const now = new Date().toISOString();
  const result: RuleImprovementsResult = {
    directionsSet: 0,
    rulesMoved: 0,
    rulesCreated: 0,
    recategorized: 0,
  };
  db.transaction((tx) => {
    for (const code of OUT_ONLY_BANK_CATEGORIES) {
      result.directionsSet += tx
        .update(transactionRules)
        .set({ direction: "out", updatedAt: now })
        .where(
          and(
            eq(transactionRules.field, "plaid_category"),
            eq(transactionRules.matchValue, code),
            sql`${transactionRules.direction} is null`,
          ),
        )
        .run().changes;
    }
    const streaming = categoryByName(tx, "Streaming");
    if (streaming) {
      result.directionsSet += tx
        .update(transactionRules)
        .set({ direction: "out", updatedAt: now })
        .where(
          and(
            eq(transactionRules.categoryId, streaming.id),
            eq(transactionRules.field, "merchant"),
            like(transactionRules.name, "%→ Streaming"),
            sql`${transactionRules.direction} is null`,
          ),
        )
        .run().changes;
    }

    // New generic rules go in just ahead of the bank-category rules.
    const firstBank = tx
      .select({ priority: transactionRules.priority })
      .from(transactionRules)
      .where(eq(transactionRules.field, "plaid_category"))
      .orderBy(asc(transactionRules.priority))
      .get();
    let next = (firstBank?.priority ?? 1000) - 1;
    for (const group of GENERIC_RULES) {
      const category = categoryByName(tx, group.category);
      if (!category || !category.active) continue;
      for (const value of group.values) {
        const name = `${group.field === "name" ? "Description" : "Merchant"} contains "${value}" → ${group.category}`;
        if (tx.select().from(transactionRules).where(eq(transactionRules.name, name)).get()) {
          continue;
        }
        tx.insert(transactionRules)
          .values({
            name,
            field: group.field,
            operator: "contains",
            matchValue: value,
            direction: group.direction,
            categoryId: category.id,
            priority: next,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        next -= 1;
        result.rulesCreated += 1;
      }
    }

    result.rulesMoved = nameRulesFirst(tx, now);
    result.recategorized = applyRules(tx).changed;
    tx.insert(appSettings).values({ key: RULES_V2_DONE, value: "true", updatedAt: now }).run();
  });
  return result;
}

/**
 * Puts every rule that matches a name, merchant, sender or recipient ahead of the rules that match
 * the bank's category, keeping the order within each group. Returns how many rules moved.
 */
function nameRulesFirst(tx: Tx, now: string): number {
  const all = tx
    .select({
      id: transactionRules.id,
      field: transactionRules.field,
      priority: transactionRules.priority,
    })
    .from(transactionRules)
    .orderBy(asc(transactionRules.priority), asc(transactionRules.id))
    .all();
  const ordered = [
    ...all.filter((r) => r.field !== "plaid_category"),
    ...all.filter((r) => r.field === "plaid_category"),
  ];
  if (ordered.every((r, i) => r.id === all[i]!.id)) return 0;
  // Keep the existing priority values, handed out in the new order, so nothing else shifts.
  const priorities = all.map((r) => r.priority);
  let moved = 0;
  ordered.forEach((rule, i) => {
    if (rule.priority === priorities[i]) return;
    tx.update(transactionRules)
      .set({ priority: priorities[i]!, updatedAt: now })
      .where(eq(transactionRules.id, rule.id))
      .run();
    moved += 1;
  });
  return moved;
}

// ---- Your own names: money between your own accounts -------------------------------------------

/** Where money sent to or from yourself is filed: under Transfers, never income or spending. */
export const OWN_ACCOUNTS_CATEGORY = "Own Accounts";
const OWN_NAME_RULE_PREFIX = "Your name ";

/**
 * Keeps one rule per name the user goes by: a description containing it (a Zelle, Venmo, Cash App
 * or bank transfer to or from yourself) files under Transfers > Own Accounts, which counts as
 * moving your own money. These rules come first. Removing a name removes its rule. Returns how
 * many transactions changed category.
 */
export function syncOwnNameRules(db: AppDb, names: string[]): number {
  const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))];
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: transactionRules.id, matchValue: transactionRules.matchValue })
      .from(transactionRules)
      .where(like(transactionRules.name, `${OWN_NAME_RULE_PREFIX}%`))
      .all();
    const keep = new Set(wanted.map((n) => n.toLowerCase()));
    for (const rule of existing) {
      if (!keep.has(rule.matchValue.toLowerCase())) {
        // Transactions it had filed are sorted again below.
        tx.run(sql`update transactions set category_id = null, category_rule_id = null,
          category_source = null where category_rule_id = ${rule.id}`);
        tx.delete(transactionRules).where(eq(transactionRules.id, rule.id)).run();
      }
    }
    if (wanted.length > 0) {
      const category = ownAccountsCategory(tx, now);
      const have = new Set(existing.map((r) => r.matchValue.toLowerCase()));
      const top = tx
        .select({ priority: transactionRules.priority })
        .from(transactionRules)
        .orderBy(asc(transactionRules.priority))
        .get();
      let priority = (top?.priority ?? 0) - 10;
      for (const name of wanted) {
        if (have.has(name.toLowerCase())) continue;
        tx.insert(transactionRules)
          .values({
            name: `${OWN_NAME_RULE_PREFIX}"${name}" → ${OWN_ACCOUNTS_CATEGORY}`,
            field: "name",
            operator: "contains",
            matchValue: name,
            direction: null,
            categoryId: category,
            priority,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        priority -= 10;
      }
    }
    return applyRules(tx).changed;
  });
}

/** Transfers > Own Accounts (moving your own money), made if missing. */
function ownAccountsCategory(tx: Tx, now: string): number {
  const transfers =
    tx
      .select({ id: categories.id })
      .from(categories)
      .where(sql`lower(${categories.name}) = 'transfers' and ${categories.parentId} is null`)
      .get() ??
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
  const existing = tx
    .select({ id: categories.id })
    .from(categories)
    .where(
      sql`lower(${categories.name}) = ${OWN_ACCOUNTS_CATEGORY.toLowerCase()}
        and ${categories.parentId} = ${transfers.id}`,
    )
    .get();
  if (existing) {
    tx.update(categories)
      .set({ incomeTreatment: "transfer", active: true, updatedAt: now })
      .where(eq(categories.id, existing.id))
      .run();
    return existing.id;
  }
  return tx
    .insert(categories)
    .values({
      name: OWN_ACCOUNTS_CATEGORY,
      color: "#94a3b8",
      parentId: transfers.id,
      active: true,
      incomeTreatment: "transfer",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: categories.id })
    .get().id;
}
