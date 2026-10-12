import { asc, eq, inArray, sql } from "drizzle-orm";
import { accounts, cashbackRules, categories } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { DEBT_KIND } from "./analytics.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Cashback on credit cards. Each card has a set of rules, and what a card has earned is worked out
 * from its purchases. It is an estimate of what the issuer will credit (issuers round and cap in their
 * own ways): each purchase earns its rate, rounded to the cent, and a refund takes its cashback back.
 * It is never part of a balance: the issuer pays it later as a statement credit, which arrives as a
 * transaction of its own.
 *
 * The rules of a card, in the order they are tried for a purchase:
 * 1. Merchant rates: a merchant whose name contains the given text earns that rate, whatever its
 *    category (the best one, when several match).
 * 2. Merchant exclusions: a merchant whose name contains the given text earns nothing from the given
 *    category (and the categories under it), or nothing at all when no category is given. Grocery
 *    stores but not Walmart is a Groceries rate plus an exclusion of "walmart" from Groceries.
 * 3. Category rates: the purchase's own category, else its parent, else "everything else".
 *
 * Any rate can be "online purchases only" (Bank of America's Customized Cash Rewards pays more online):
 * it applies only to a purchase bought online, and the purchase earns the higher of its online and
 * ordinary rates. Whether a purchase was online is the user's call if they made one, else the bank's
 * payment channel.
 */

export interface CashbackRuleDto {
  /** For a category rate, its category (null is "everything else"); for an exclusion, what it is from. */
  categoryId: number | null;
  categoryName: string | null;
  /** For a merchant rate or an exclusion: text the merchant's name contains. */
  merchant: string | null;
  /** True for an exclusion (it has no rate). */
  exclude: boolean;
  /** A percentage such as 1.5 (0 for an exclusion). */
  ratePercent: number;
  /** True for a rate that applies only to purchases made online. */
  onlineOnly: boolean;
}

export interface CashbackRuleInput {
  categoryId: number | null;
  ratePercent: number;
  onlineOnly?: boolean | undefined;
  merchant?: string | null | undefined;
  exclude?: boolean | undefined;
}

const MAX_RATE_PERCENT = 100;

function requireCreditCard(db: AppDb, accountId: number): void {
  const account = db
    .select({ type: accounts.type })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) throw notFound("That account");
  if (account.type !== "credit") {
    throw new AppError(409, "not_a_credit_card", "Cashback rates belong to credit cards.");
  }
}

export function getCashbackRules(db: AppDb, accountId: number): CashbackRuleDto[] {
  requireCreditCard(db, accountId);
  return db
    .select({
      categoryId: cashbackRules.categoryId,
      categoryName: categories.name,
      rateBps: cashbackRules.rateBps,
      onlineOnly: cashbackRules.onlineOnly,
      merchant: cashbackRules.merchant,
      exclude: cashbackRules.exclude,
    })
    .from(cashbackRules)
    .leftJoin(categories, eq(categories.id, cashbackRules.categoryId))
    .where(eq(cashbackRules.accountId, accountId))
    .orderBy(asc(cashbackRules.id))
    .all()
    .map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      merchant: r.merchant,
      exclude: r.exclude,
      ratePercent: r.rateBps / 100,
      onlineOnly: r.onlineOnly,
    }));
}

/** Replaces a card's whole set of rules. An empty list means the card earns nothing tracked. */
export function setCashbackRules(
  db: AppDb,
  accountId: number,
  input: CashbackRuleInput[],
  now: string = new Date().toISOString(),
): CashbackRuleDto[] {
  requireCreditCard(db, accountId);
  const rules = input.map((r) => {
    const merchant = r.merchant?.trim() ? r.merchant.trim() : null;
    const exclude = r.exclude === true;
    if (exclude && merchant === null) {
      throw new AppError(400, "invalid_rule", "An exclusion needs the merchant to leave out.");
    }
    return {
      // A merchant rate applies whatever the category.
      categoryId: merchant !== null && !exclude ? null : r.categoryId,
      merchant,
      exclude,
      ratePercent: exclude ? 0 : r.ratePercent,
      onlineOnly: !exclude && r.onlineOnly === true,
    };
  });
  const seen = new Set<string>();
  for (const rule of rules) {
    if (
      !Number.isFinite(rule.ratePercent) ||
      rule.ratePercent < 0 ||
      rule.ratePercent > MAX_RATE_PERCENT ||
      Math.abs(rule.ratePercent * 100 - Math.round(rule.ratePercent * 100)) > 1e-9
    ) {
      throw new AppError(
        400,
        "invalid_rate",
        "Enter a cashback rate from 0 to 100 percent, with at most two decimal places.",
      );
    }
    if (rule.merchant !== null && rule.merchant.length > 100) {
      throw new AppError(400, "invalid_rule", "Keep a merchant name to 100 characters.");
    }
    const kind = rule.exclude ? "exclude" : rule.merchant !== null ? "merchant" : "category";
    const key = `${kind}:${rule.categoryId ?? "all"}:${rule.merchant?.toLowerCase() ?? ""}:${rule.onlineOnly}`;
    if (seen.has(key)) {
      const online = rule.onlineOnly ? " for online purchases" : "";
      throw new AppError(
        400,
        "duplicate_rate",
        kind === "exclude"
          ? `"${rule.merchant}" is excluded twice in the same way.`
          : kind === "merchant"
            ? `"${rule.merchant}" has two rates${online}.`
            : rule.categoryId === null
              ? `There can be only one rate for everything else${online}.`
              : `Each category can have only one rate${online} on a card.`,
      );
    }
    seen.add(key);
  }
  const categoryIds = [
    ...new Set(rules.map((r) => r.categoryId).filter((id): id is number => id !== null)),
  ];
  if (categoryIds.length > 0) {
    const found = db
      .select({ id: categories.id })
      .from(categories)
      .where(inArray(categories.id, categoryIds))
      .all();
    if (found.length !== categoryIds.length) {
      throw new AppError(400, "unknown_category", "One of those categories does not exist.");
    }
  }
  db.transaction((tx) => {
    tx.delete(cashbackRules).where(eq(cashbackRules.accountId, accountId)).run();
    for (const rule of rules) {
      tx.insert(cashbackRules)
        .values({
          accountId,
          categoryId: rule.categoryId,
          merchant: rule.merchant,
          exclude: rule.exclude,
          rateBps: Math.round(rule.ratePercent * 100),
          onlineOnly: rule.onlineOnly,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });
  return getCashbackRules(db, accountId);
}

// ---- Working out a purchase's rate ------------------------------------------------------------

interface Row {
  id: number;
  account_id: number;
  amount_minor: number;
  category_id: number | null;
  parent_id: number | null;
  online: number;
  /** The merchant's name in lower case, for merchant rules. */
  merchant: string;
}

interface StoredRule {
  accountId: number;
  categoryId: number | null;
  rateBps: number;
  onlineOnly: boolean;
  merchant: string | null;
  exclude: boolean;
}

type RateTable = { byCategory: Map<number, number>; fallback: number | null };

interface CardRules {
  any: RateTable;
  online: RateTable;
  merchants: Array<{ text: string; label: string; bps: number; onlineOnly: boolean }>;
  exclusions: Array<{ text: string; categoryId: number | null }>;
}

export interface UsedRate {
  bps: number;
  online: boolean;
  /** The category of the rate (null for "everything else" or a merchant rate). */
  categoryId: number | null;
  /** The merchant rule that set the rate, if one did. */
  merchant: string | null;
}

function compileRules(rules: StoredRule[]): CardRules {
  const card: CardRules = {
    any: { byCategory: new Map(), fallback: null },
    online: { byCategory: new Map(), fallback: null },
    merchants: [],
    exclusions: [],
  };
  for (const r of rules) {
    if (r.merchant !== null) {
      const text = r.merchant.toLowerCase();
      if (r.exclude) card.exclusions.push({ text, categoryId: r.categoryId });
      else
        card.merchants.push({ text, label: r.merchant, bps: r.rateBps, onlineOnly: r.onlineOnly });
      continue;
    }
    const table = r.onlineOnly ? card.online : card.any;
    if (r.categoryId === null) table.fallback = r.rateBps;
    else table.byCategory.set(r.categoryId, r.rateBps);
  }
  return card;
}

/** The rate a purchase earns on a card, or null when it earns nothing there. */
function pickRate(
  card: CardRules,
  row: Omit<Row, "id" | "account_id" | "amount_minor">,
): UsedRate | null {
  const online = row.online === 1;
  // 1. A merchant rate beats any category rate.
  let best: UsedRate | null = null;
  for (const m of card.merchants) {
    if (!row.merchant.includes(m.text) || (m.onlineOnly && !online)) continue;
    if (!best || m.bps > best.bps) {
      best = { bps: m.bps, online: m.onlineOnly, categoryId: null, merchant: m.label };
    }
  }
  if (best) return best;

  // 2. Exclusions: from everything, or from a category and the ones under it.
  const excluded = new Set<number>();
  for (const x of card.exclusions) {
    if (!row.merchant.includes(x.text)) continue;
    if (x.categoryId === null) return null;
    excluded.add(x.categoryId);
  }
  const categoryBlocked =
    (row.category_id !== null && excluded.has(row.category_id)) ||
    (row.parent_id !== null && excluded.has(row.parent_id));

  // 3. Own category, then its parent, then everything else.
  const lookup = (table: RateTable): { categoryId: number | null; bps: number } | null => {
    if (!categoryBlocked) {
      const own = row.category_id !== null ? table.byCategory.get(row.category_id) : undefined;
      if (own !== undefined) return { categoryId: row.category_id, bps: own };
      const parent = row.parent_id !== null ? table.byCategory.get(row.parent_id) : undefined;
      if (parent !== undefined) return { categoryId: row.parent_id, bps: parent };
    }
    return table.fallback !== null ? { categoryId: null, bps: table.fallback } : null;
  };
  const ordinary = lookup(card.any);
  const onlineRate = online ? lookup(card.online) : null;
  if (onlineRate && (!ordinary || onlineRate.bps > ordinary.bps)) {
    return { ...onlineRate, online: true, merchant: null };
  }
  return ordinary ? { ...ordinary, online: false, merchant: null } : null;
}

/** Purchases that can earn cashback: not transfers, card payments, fees, interest, or zero. */
const EARNS = sql`t.is_transfer = 0
      and ${DEBT_KIND} is null
      and coalesce(t.plaid_category_primary, '') <> 'BANK_FEES'
      and coalesce(t.plaid_category_detailed, '') not like 'LOAN_PAYMENTS%'
      and coalesce(t.plaid_category_detailed, '') not like '%INTEREST%'
      and t.amount_minor <> 0`;

const ROW_COLUMNS = sql`t.id as id, t.account_id as account_id, t.amount_minor as amount_minor,
      t.category_id as category_id, c.parent_id as parent_id,
      case when coalesce(t.online_user, t.payment_channel = 'online') then 1 else 0 end as online,
      lower(coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name)) as merchant`;

function loadRules(db: AppDb, accountIds: number[]): Map<number, CardRules> {
  if (accountIds.length === 0) return new Map();
  const rows = db
    .select({
      accountId: cashbackRules.accountId,
      categoryId: cashbackRules.categoryId,
      rateBps: cashbackRules.rateBps,
      onlineOnly: cashbackRules.onlineOnly,
      merchant: cashbackRules.merchant,
      exclude: cashbackRules.exclude,
    })
    .from(cashbackRules)
    .where(inArray(cashbackRules.accountId, accountIds))
    .all();
  const byCard = new Map<number, CardRules>();
  for (const id of new Set(rows.map((r) => r.accountId))) {
    byCard.set(id, compileRules(rows.filter((r) => r.accountId === id)));
  }
  return byCard;
}

/** The credit cards in use (visible, and of the Plaid environment in use, or kept by hand). */
function currentCards(db: AppDb) {
  const settings = getSettings(db);
  return listAccounts(db).filter(
    (a) =>
      a.type === "credit" &&
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment),
  );
}

// ---- Each transaction: was the best card used? ------------------------------------------------

export interface TransactionCashback {
  /**
   * `best`: paid with the card that earns the most for it. `card`: paid with a credit card, but
   * another earns more. `missed`: a purchase not paid with a credit card at all.
   */
  status: "best" | "card" | "missed";
  /** What this purchase is estimated to earn where it was paid (0 when nothing). */
  cashbackMinor: number;
  rateBps: number;
  /** The best rate any card would have given, and that card (null when none earns anything). */
  bestRateBps: number;
  bestCard: string | null;
  online: boolean;
}

/**
 * For each of these transactions that is a purchase: what it earned, and whether the best card for
 * it was used. Refunds, transfers, payments to people, card payments, fees, and income are left out.
 */
export function transactionCashback(db: AppDb, ids: number[]): Map<number, TransactionCashback> {
  const result = new Map<number, TransactionCashback>();
  if (ids.length === 0) return result;
  const rows = db.all<Row & { account_type: string }>(sql`
    select ${ROW_COLUMNS}, a.type as account_type
    from transactions t
      join accounts a on a.id = t.account_id
      left join categories c on c.id = t.category_id
    where t.id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      and t.amount_minor > 0
      and a.type in ('credit', 'depository', 'other')
      and ${EARNS}
      and coalesce(t.plaid_category_primary, '') not in ('TRANSFER_OUT', 'TRANSFER_IN', 'LOAN_PAYMENTS', 'INCOME')
      and (a.type = 'credit' or coalesce(t.recipient_user, t.recipient) is null)`);
  if (rows.length === 0) return result;
  const cards = currentCards(db);
  const rules = loadRules(
    db,
    cards.map((c) => c.id),
  );
  const names = new Map(cards.map((c) => [c.id, c.name]));
  for (const row of rows) {
    let best: { bps: number; card: number } | null = null;
    for (const [cardId, card] of rules) {
      const used = pickRate(card, row);
      if (used && used.bps > 0 && (!best || used.bps > best.bps))
        best = { bps: used.bps, card: cardId };
    }
    const here = row.account_type === "credit" ? rules.get(row.account_id) : undefined;
    const used = here ? pickRate(here, row) : null;
    const bps = used?.bps ?? 0;
    const status: TransactionCashback["status"] =
      row.account_type !== "credit"
        ? "missed"
        : bps > 0 && bps >= (best?.bps ?? 0)
          ? "best"
          : "card";
    result.set(row.id, {
      status,
      cashbackMinor: Math.round((row.amount_minor * bps) / 10_000),
      rateBps: bps,
      bestRateBps: best?.bps ?? 0,
      bestCard: best ? (names.get(best.card) ?? null) : null,
      online: used?.online ?? false,
    });
  }
  return result;
}

// ---- What each card earned over a period ------------------------------------------------------

export interface CashbackBucket {
  /** The category the rate is set for, or null for "everything else" or a merchant rate. */
  categoryId: number | null;
  /** The merchant rule that set the rate, if one did. */
  merchant: string | null;
  /** True when this row is the rate for online purchases. */
  online: boolean;
  label: string;
  rateBps: number | null;
  spendMinor: number;
  cashbackMinor: number;
}

export interface CardCashback {
  accountId: number;
  name: string;
  color: string | null;
  institutionName: string | null;
  cashbackMinor: number;
  /** What was bought with the card (refunds taken off) that the period's cashback is worked out from. */
  spendMinor: number;
  hasRates: boolean;
  buckets: CashbackBucket[];
}

export interface CashbackSummary {
  from: string;
  to: string;
  currency: string;
  totalCashbackMinor: number;
  cards: CardCashback[];
}

/** What each credit card earned between two days, from its purchases and its rules. */
export function cashbackSummary(
  db: AppDb,
  options: { from: string; to: string; accountId?: number | undefined },
): CashbackSummary {
  const { from, to } = options;
  if (!isRealDate(from) || !isRealDate(to)) {
    throw new AppError(400, "invalid_date", "Dates must be real days written as YYYY-MM-DD.");
  }
  if (from > to) throw new AppError(400, "invalid_range", "The start date is after the end date.");
  const settings = getSettings(db);
  const cards = currentCards(db).filter(
    (a) => options.accountId === undefined || a.id === options.accountId,
  );
  const result: CashbackSummary = {
    from,
    to,
    currency: settings.currency,
    totalCashbackMinor: 0,
    cards: [],
  };
  if (cards.length === 0) return result;
  const ids = cards.map((c) => c.id);
  const rules = loadRules(db, ids);
  const names = new Map(
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .all()
      .map((c) => [c.id, c.name]),
  );

  const rows = db.all<Row>(sql`
    select ${ROW_COLUMNS}
    from transactions t
      join accounts a on a.id = t.account_id
      left join categories c on c.id = t.category_id
    where coalesce(t.authorized_date, t.date) between ${from} and ${to}
      and t.account_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      and ${EARNS}`);

  for (const card of cards) {
    const mine = rules.get(card.id);
    // One row per rate that was used, plus one for purchases that have no rate.
    const buckets = new Map<string, CashbackBucket>();
    let cashback = 0;
    let spend = 0;
    for (const row of rows.filter((r) => r.account_id === card.id)) {
      spend += row.amount_minor;
      const used = mine ? pickRate(mine, row) : null;
      const bps = used?.bps ?? null;
      const earned = bps === null ? 0 : Math.round((row.amount_minor * bps) / 10_000);
      cashback += earned;
      const key =
        used === null
          ? "none"
          : `${used.merchant ?? ""}:${used.categoryId}:${used.online ? "online" : "any"}`;
      let b = buckets.get(key);
      if (!b) {
        const base =
          used === null
            ? "No rate set"
            : used.merchant !== null
              ? `Merchant “${used.merchant}”`
              : used.categoryId === null
                ? "Everything else"
                : (names.get(used.categoryId) ?? "Category");
        b = {
          categoryId: used?.categoryId ?? null,
          merchant: used?.merchant ?? null,
          online: used?.online ?? false,
          label: base + (used?.online ? " (online)" : ""),
          rateBps: bps,
          spendMinor: 0,
          cashbackMinor: 0,
        };
        buckets.set(key, b);
      }
      b.spendMinor += row.amount_minor;
      b.cashbackMinor += earned;
    }
    result.cards.push({
      accountId: card.id,
      name: card.name,
      color: card.color,
      institutionName: card.institutionName,
      cashbackMinor: cashback,
      spendMinor: spend,
      hasRates: mine !== undefined,
      buckets: [...buckets.values()].sort((a, b) => b.cashbackMinor - a.cashbackMinor),
    });
    result.totalCashbackMinor += cashback;
  }
  result.cards.sort((a, b) => b.cashbackMinor - a.cashbackMinor);
  return result;
}
