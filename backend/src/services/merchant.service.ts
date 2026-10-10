import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { categories, transactionRules, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import { merchantKey } from "../utils/merchant.js";
import { applyRules, createRule, deleteRule, listRules } from "./rule.service.js";
import { getSettings } from "./settings.service.js";
import { countedAccount } from "./account-scope.js";

/**
 * Merchants as a way to organize categories: every merchant that appears in the transactions,
 * with how many transactions it has and which category it is assigned to.
 *
 * A merchant is a place, not a spelling: "Chipotle", "CHIPOTLE 2041" and "Chipotle #1999" are one
 * merchant (see `merchantKey`), because a bank often shows the same place under several
 * descriptions and a cleaned name sometimes arrives only later.
 *
 * "Assigning a merchant to a category" is a rule underneath ("merchant is the same as X →
 * category"), so it behaves like every other rule: it categorizes the merchant's existing
 * transactions now and its future ones as they arrive, it never overrides a category the user
 * picked on a single transaction (unless asked to), and it shows up on the rules list.
 */

/** The merchant as the user sees it: their edit, else the bank's cleaned name, else the description. */
const MERCHANT = sql`coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name)`;

export interface MerchantRow {
  /** The merchant's normalized name: how merchants are matched. */
  key: string;
  /** The name as it appears on the most recent transaction. */
  merchant: string;
  transactionCount: number;
  lastDate: string;
  /** How many of its transactions have no category. */
  uncategorizedCount: number;
  /** How many different categories its transactions have (more than one means they are mixed). */
  categoryCount: number;
  /** The category this merchant is assigned to, if it is. */
  assigned: { ruleId: number; categoryId: number; categoryName: string } | null;
}

interface Variant {
  m: string;
  category_id: number | null;
  n: number;
  last: string;
}

/** One row per spelling and category, visible in the active data source. */
function variants(db: AppDb): Variant[] {
  const environment = getSettings(db).plaidEnvironment;
  return db.all<Variant>(sql`
    SELECT ${MERCHANT} AS m, t.category_id AS category_id, count(*) AS n, max(t.date) AS last
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN plaid_items p ON p.id = a.plaid_item_id
    WHERE (p.environment = ${environment} OR a.plaid_item_id IS NULL) AND ${countedAccount()}
    GROUP BY ${MERCHANT}, t.category_id
  `);
}

/** Spellings that are the same place, merged. */
function groupedMerchants(db: AppDb): Array<Omit<MerchantRow, "assigned">> {
  const groups = new Map<
    string,
    {
      n: number;
      last: string;
      uncategorized: number;
      cats: Set<number>;
      display: string;
      displayLast: string;
    }
  >();
  for (const v of variants(db)) {
    const key = merchantKey(v.m);
    if (key === "") continue;
    const g = groups.get(key) ?? {
      n: 0,
      last: "",
      uncategorized: 0,
      cats: new Set<number>(),
      display: v.m,
      displayLast: "",
    };
    g.n += v.n;
    if (v.last > g.last) g.last = v.last;
    if (v.category_id === null) g.uncategorized += v.n;
    else g.cats.add(v.category_id);
    // Shown under the spelling of the most recent transaction.
    if (v.last > g.displayLast) {
      g.displayLast = v.last;
      g.display = v.m;
    }
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    merchant: g.display,
    transactionCount: g.n,
    lastDate: g.last,
    uncategorizedCount: g.uncategorized,
    categoryCount: g.cats.size,
  }));
}

/** The merchant-assignment rules by merchant key, the highest-priority one winning. */
function merchantRules(db: AppDb): Map<string, NonNullable<MerchantRow["assigned"]>> {
  const out = new Map<string, NonNullable<MerchantRow["assigned"]>>();
  for (const rule of listRules(db)) {
    if (rule.field !== "merchant" || !rule.enabled) continue;
    if (rule.operator !== "equals" && rule.operator !== "same_merchant") continue;
    const key = merchantKey(rule.matchValue);
    if (key === "" || out.has(key)) continue;
    out.set(key, { ruleId: rule.id, categoryId: rule.categoryId, categoryName: rule.categoryName });
  }
  return out;
}

export interface MerchantQuery {
  q?: string | undefined;
  /** `all`, `assigned`, `unassigned`, or a category ID to see only the merchants assigned to it. */
  assigned?: "all" | "assigned" | "unassigned" | number | undefined;
  limit: number;
  offset: number;
}

export function listMerchants(
  db: AppDb,
  query: MerchantQuery,
): { total: number; rows: MerchantRow[] } {
  const rules = merchantRules(db);
  const needle = query.q?.trim().toLowerCase() ?? "";
  const assigned = query.assigned ?? "all";
  const all: MerchantRow[] = groupedMerchants(db)
    .filter(
      (g) => needle === "" || g.key.includes(needle) || g.merchant.toLowerCase().includes(needle),
    )
    .map((g) => ({ ...g, assigned: rules.get(g.key) ?? null }))
    .filter((m) => {
      if (assigned === "all") return true;
      if (assigned === "assigned") return m.assigned !== null;
      if (assigned === "unassigned") return m.assigned === null;
      return m.assigned?.categoryId === assigned;
    })
    .sort((a, b) => b.transactionCount - a.transactionCount || a.key.localeCompare(b.key));
  return { total: all.length, rows: all.slice(query.offset, query.offset + query.limit) };
}

export interface AssignInput {
  merchant: string;
  /** The category to assign, or null to remove the assignment. */
  categoryId: number | null;
  /** Also replace categories the user picked by hand on this merchant's transactions. */
  overrideManual?: boolean | undefined;
}

export interface AssignResult {
  merchant: string;
  /** How many of the merchant's transactions now have a different category. */
  changed: number;
  transactions: number;
  assigned: MerchantRow["assigned"];
}

/** IDs of every transaction of a merchant, however its name is spelled. */
function transactionIds(db: AppDb, key: string): number[] {
  return db
    .all<{ id: number; m: string }>(sql`SELECT t.id AS id, ${MERCHANT} AS m FROM transactions t`)
    .filter((row) => merchantKey(row.m) === key)
    .map((row) => row.id);
}

/**
 * Puts a merchant in a category (or takes it out). The assignment is a rule, so it also applies to
 * the merchant's future transactions. It goes to the top of the rule order so it wins over older
 * and built-in rules, as a rule written on purpose should.
 */
export function assignMerchant(db: AppDb, input: AssignInput): AssignResult {
  const display = input.merchant.trim();
  const key = merchantKey(display);
  if (key === "") throw new AppError(400, "invalid_merchant", "Choose a merchant.");

  const ids = transactionIds(db, key);
  if (ids.length === 0) throw new AppError(404, "not_found", "No transactions have that merchant.");
  // Checked before anything changes, so a refused request leaves every rule as it was.
  if (input.categoryId !== null) {
    const target = db
      .select({ active: categories.active })
      .from(categories)
      .where(eq(categories.id, input.categoryId))
      .get();
    if (!target) throw new AppError(400, "unknown_category", "That category does not exist.");
    if (!target.active) {
      throw new AppError(400, "inactive_category", "That category is archived. Restore it first.");
    }
  }

  const before = new Map(
    db
      .select({ id: transactions.id, categoryId: transactions.categoryId })
      .from(transactions)
      .where(inArray(transactions.id, ids))
      .all()
      .map((r) => [r.id, r.categoryId]),
  );

  const existing = listRules(db).filter(
    (r) =>
      r.field === "merchant" &&
      (r.operator === "equals" || r.operator === "same_merchant") &&
      merchantKey(r.matchValue) === key,
  );

  if (input.categoryId === null) {
    for (const rule of existing) deleteRule(db, rule.id);
  } else {
    const [keep, ...extras] = existing;
    for (const extra of extras) deleteRule(db, extra.id);
    if (keep) {
      // Reuse the existing rule: point it at the new category, match every spelling, move it to the top.
      const lowest = db
        .select({ priority: transactionRules.priority })
        .from(transactionRules)
        .where(ne(transactionRules.id, keep.id))
        .orderBy(asc(transactionRules.priority))
        .get();
      db.update(transactionRules)
        .set({
          categoryId: input.categoryId,
          operator: "same_merchant",
          enabled: true,
          priority: lowest ? Math.min(keep.priority, lowest.priority - 10) : keep.priority,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(transactionRules.id, keep.id))
        .run();
    } else {
      createRule(db, {
        name: `Merchant: ${display}`,
        field: "merchant",
        operator: "same_merchant",
        matchValue: display,
        categoryId: input.categoryId,
      });
    }
    if (input.overrideManual) {
      db.update(transactions)
        .set({ categoryId: null, categorySource: null, categoryRuleId: null })
        .where(and(inArray(transactions.id, ids), eq(transactions.categorySource, "manual")))
        .run();
    }
  }
  applyRules(db, ids);

  const after = db
    .select({ id: transactions.id, categoryId: transactions.categoryId })
    .from(transactions)
    .where(inArray(transactions.id, ids))
    .all();
  const changed = after.filter((r) => before.get(r.id) !== r.categoryId).length;
  return {
    merchant: display,
    changed,
    transactions: ids.length,
    assigned: merchantRules(db).get(key) ?? null,
  };
}
