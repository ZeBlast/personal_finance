import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import {
  accounts,
  categories,
  plaidItems,
  transactionRules,
  transactions,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import type { GatewayTransaction } from "../plaid/gateway.js";
import { AppError, notFound } from "../utils/errors.js";
import { toMinorUnits } from "../utils/money.js";
import { extractRecipient, looksLikeTransfer } from "./recipient.js";
import { applyRules } from "./rule.service.js";

type Db = Pick<AppDb, "select" | "insert" | "update" | "delete">;

/**
 * Stores one transaction from the provider and says whether it was new, and which row it is.
 *
 * Only provider columns are written here. The user's own edits (`*_user` columns and the category
 * they chose) are never touched, so they survive every refresh. When a posted transaction replaces
 * a pending one (Plaid gives it a new ID), the existing row is kept and updated in place, so the
 * user's edits and the row's internal ID carry over.
 */
export function upsertTransaction(
  db: Db,
  accountId: number,
  t: GatewayTransaction,
  now: string,
): { kind: "added" | "modified"; id: number } {
  const amountMinor = toMinorUnits(t.amount, t.currency);
  if (amountMinor === null) throw new Error("Transaction has no valid amount");

  const recipient = extractRecipient({
    name: t.name,
    amount: t.amount,
    paymentPayee: t.paymentPayee,
    paymentPayer: t.paymentPayer,
  });
  const counterparty = t.counterparties[0];
  const provider = {
    accountId,
    plaidTransactionId: t.transactionId,
    pendingPlaidTransactionId: t.pendingTransactionId,
    date: t.date,
    authorizedDate: t.authorizedDate,
    name: t.name,
    merchantName: t.merchantName,
    amountMinor,
    currency: t.currency,
    pending: t.pending,
    paymentChannel: t.paymentChannel,
    plaidCategoryPrimary: t.categoryPrimary,
    plaidCategoryDetailed: t.categoryDetailed,
    counterpartyName: counterparty?.name ?? null,
    counterpartyType: counterparty?.type ?? null,
    recipient: recipient?.recipient ?? null,
    recipientSource: recipient?.source ?? null,
    isTransfer: looksLikeTransfer(t.categoryPrimary, recipient),
    updatedAt: now,
  };

  const byId = (id: string) =>
    db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.plaidTransactionId, id))
      .get();

  const existing =
    byId(t.transactionId) ?? (t.pendingTransactionId ? byId(t.pendingTransactionId) : undefined);
  if (existing) {
    db.update(transactions).set(provider).where(eq(transactions.id, existing.id)).run();
    return { kind: "modified", id: existing.id };
  }
  const inserted = db
    .insert(transactions)
    .values({ ...provider, createdAt: now })
    .returning({ id: transactions.id })
    .get();
  return { kind: "added", id: inserted.id };
}

const REMOVE_CHUNK = 400;

/** Deletes transactions the provider says no longer exist; returns the IDs actually deleted. */
export function removeTransactions(db: Db, plaidIds: string[]): string[] {
  const removed: string[] = [];
  for (let i = 0; i < plaidIds.length; i += REMOVE_CHUNK) {
    const chunk = plaidIds.slice(i, i + REMOVE_CHUNK);
    const rows = db
      .delete(transactions)
      .where(inArray(transactions.plaidTransactionId, chunk))
      .returning({ id: transactions.plaidTransactionId })
      .all();
    for (const row of rows) if (row.id) removed.push(row.id);
  }
  return removed;
}

// ---- Reading ---------------------------------------------------------------------------

export const SORTS = [
  "date_desc",
  "date_asc",
  "amount_asc",
  "amount_desc",
  "merchant_asc",
  "merchant_desc",
] as const;
export type Sort = (typeof SORTS)[number];

export interface TransactionQuery {
  page: number;
  pageSize: number;
  accountId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  pending?: boolean | undefined;
  q?: string | undefined;
  /** A category ID (including its subcategories) or "none" for uncategorized. */
  category?: number | "none" | undefined;
  /**
   * `amount_*` sorts by the amount as people read it: spending is negative, money in is positive,
   * so `amount_asc` puts the biggest purchases first.
   */
  sort?: Sort | undefined;
  /** Only transactions of connections in this environment (manual accounts always included). */
  environment: string;
}

export interface TransactionDto {
  id: number;
  accountId: number;
  accountName: string;
  accountColor: string | null;
  institutionName: string | null;
  date: string;
  authorizedDate: string | null;
  name: string;
  /** The user's edit if there is one, else the provider's merchant, else the raw description. */
  merchant: string;
  merchantEdited: boolean;
  /** What the bank supplied, for "reset to the bank's value". */
  providerMerchant: string;
  amountMinor: number;
  currency: string;
  pending: boolean;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  /** The category in use and how it was chosen, or null when there is none yet. */
  category: {
    id: number;
    name: string;
    color: string | null;
    active: boolean;
    source: "manual" | "rule";
    ruleName: string | null;
  } | null;
  /** Person on the other side of a transfer: the user's edit, else the provider/parsed value. */
  recipient: string | null;
  recipientSource: "plaid" | "parsed" | "manual" | null;
  providerRecipient: string | null;
  isTransfer: boolean;
  paymentChannel: string | null;
  notes: string | null;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

const effectiveMerchant = sql`lower(coalesce(nullif(trim(${transactions.merchantNameUser}), ''), ${transactions.merchantName}, ${transactions.name}))`;

const selectColumns = {
  id: transactions.id,
  accountId: transactions.accountId,
  accountName: accounts.name,
  accountColor: accounts.color,
  institutionName: plaidItems.institutionName,
  date: transactions.date,
  authorizedDate: transactions.authorizedDate,
  name: transactions.name,
  merchantName: transactions.merchantName,
  merchantNameUser: transactions.merchantNameUser,
  amountMinor: transactions.amountMinor,
  currency: transactions.currency,
  pending: transactions.pending,
  categoryPrimary: transactions.plaidCategoryPrimary,
  categoryDetailed: transactions.plaidCategoryDetailed,
  recipient: transactions.recipient,
  recipientSource: transactions.recipientSource,
  recipientUser: transactions.recipientUser,
  isTransfer: transactions.isTransfer,
  paymentChannel: transactions.paymentChannel,
  notesUser: transactions.notesUser,
  categoryId: transactions.categoryId,
  categorySource: transactions.categorySource,
  categoryName: categories.name,
  categoryColor: categories.color,
  categoryActive: categories.active,
  ruleName: transactionRules.name,
};

function selectTransactions(db: Pick<AppDb, "select">) {
  return db
    .select(selectColumns)
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(plaidItems, eq(accounts.plaidItemId, plaidItems.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(transactionRules, eq(transactions.categoryRuleId, transactionRules.id));
}

type Row = ReturnType<typeof selectTransactions> extends { all(): Array<infer R> } ? R : never;

function toDto(r: Row): TransactionDto {
  const manualRecipient = r.recipientUser?.trim() ? r.recipientUser : null;
  const manualMerchant = r.merchantNameUser?.trim() ? r.merchantNameUser : null;
  const providerMerchant = r.merchantName || r.name;
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    accountColor: r.accountColor,
    institutionName: r.institutionName,
    date: r.date,
    authorizedDate: r.authorizedDate,
    name: r.name,
    merchant: manualMerchant ?? providerMerchant,
    merchantEdited: manualMerchant !== null,
    providerMerchant,
    amountMinor: r.amountMinor,
    currency: r.currency,
    pending: r.pending,
    categoryPrimary: r.categoryPrimary,
    categoryDetailed: r.categoryDetailed,
    category:
      r.categoryId !== null && r.categoryName !== null
        ? {
            id: r.categoryId,
            name: r.categoryName,
            color: r.categoryColor,
            active: r.categoryActive ?? true,
            source: r.categorySource === "manual" ? "manual" : "rule",
            ruleName: r.ruleName,
          }
        : null,
    recipient: manualRecipient ?? r.recipient,
    recipientSource: manualRecipient ? "manual" : (r.recipientSource as "plaid" | "parsed" | null),
    providerRecipient: r.recipient,
    isTransfer: r.isTransfer,
    paymentChannel: r.paymentChannel,
    notes: r.notesUser,
  };
}

function orderBy(sort: Sort): SQL[] {
  const tieBreak = [desc(transactions.date), desc(transactions.id)];
  switch (sort) {
    case "date_asc":
      return [asc(transactions.date), asc(transactions.id)];
    case "amount_asc":
      return [desc(transactions.amountMinor), ...tieBreak]; // displayed amount = -amount_minor
    case "amount_desc":
      return [asc(transactions.amountMinor), ...tieBreak];
    case "merchant_asc":
      return [asc(effectiveMerchant), ...tieBreak];
    case "merchant_desc":
      return [desc(effectiveMerchant), ...tieBreak];
    default:
      return tieBreak;
  }
}

export function listTransactions(
  db: AppDb,
  query: TransactionQuery,
): { items: TransactionDto[]; total: number; page: number; pageSize: number } {
  const conditions: SQL[] = [
    or(eq(plaidItems.environment, query.environment), sql`${accounts.plaidItemId} IS NULL`)!,
  ];
  if (query.accountId !== undefined) conditions.push(eq(transactions.accountId, query.accountId));
  if (query.from) conditions.push(gte(transactions.date, query.from));
  if (query.to) conditions.push(lte(transactions.date, query.to));
  if (query.pending !== undefined) conditions.push(eq(transactions.pending, query.pending));
  if (query.category === "none") conditions.push(isNull(transactions.categoryId));
  else if (query.category !== undefined) {
    // Choosing a parent category includes its subcategories.
    const ids = [
      query.category,
      ...db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.parentId, query.category))
        .all()
        .map((row) => row.id),
    ];
    conditions.push(inArray(transactions.categoryId, ids));
  }
  if (query.q?.trim()) {
    const pattern = `%${escapeLike(query.q.trim())}%`;
    const matches = (column: AnyColumn) => sql`${column} LIKE ${pattern} ESCAPE '\\'`;
    conditions.push(
      or(
        matches(transactions.name),
        matches(transactions.merchantName),
        matches(transactions.merchantNameUser),
        matches(transactions.recipient),
        matches(transactions.recipientUser),
        matches(transactions.notesUser),
        matches(categories.name),
      )!,
    );
  }
  const where = and(...conditions);

  const total =
    db
      .select({ n: count() })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(plaidItems, eq(accounts.plaidItemId, plaidItems.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(where)
      .get()?.n ?? 0;

  const rows = selectTransactions(db)
    .where(where)
    .orderBy(...orderBy(query.sort ?? "date_desc"))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
}

export function getTransaction(db: AppDb, id: number): TransactionDto {
  const row = selectTransactions(db).where(eq(transactions.id, id)).get();
  if (!row) throw notFound("That transaction");
  return toDto(row);
}

// ---- Editing ---------------------------------------------------------------------------

export interface TransactionPatch {
  /** A category ID to assign by hand, or null to clear it and let the rules decide. */
  categoryId?: number | null | undefined;
  /** Text to show instead of the bank's merchant; null or empty goes back to the bank's. */
  merchant?: string | null | undefined;
  /** The person on the other side of a transfer; null or empty goes back to the detected one. */
  recipient?: string | null | undefined;
  notes?: string | null | undefined;
}

const blankToNull = (text: string | null): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/**
 * Applies the user's edits. Each field is stored apart from the bank's data, so a later sync never
 * overwrites it. A category chosen here is final: rules will not change it. Clearing it hands the
 * transaction back to the rules.
 */
export function updateTransaction(db: AppDb, id: number, patch: TransactionPatch): TransactionDto {
  const current = db
    .select({ categorySource: transactions.categorySource })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!current) throw notFound("That transaction");

  const changes: Partial<typeof transactions.$inferInsert> = {};
  let source = current.categorySource;

  if (patch.categoryId !== undefined) {
    if (patch.categoryId === null) {
      changes.categoryId = null;
      changes.categorySource = null;
      changes.categoryRuleId = null;
      source = null;
    } else {
      const category = db
        .select({ active: categories.active })
        .from(categories)
        .where(eq(categories.id, patch.categoryId))
        .get();
      if (!category) throw new AppError(400, "unknown_category", "That category does not exist.");
      if (!category.active) {
        throw new AppError(
          400,
          "inactive_category",
          "That category is archived. Restore it first.",
        );
      }
      changes.categoryId = patch.categoryId;
      changes.categorySource = "manual";
      changes.categoryRuleId = null;
      source = "manual";
    }
  }
  if (patch.merchant !== undefined) changes.merchantNameUser = blankToNull(patch.merchant);
  if (patch.recipient !== undefined) changes.recipientUser = blankToNull(patch.recipient);
  if (patch.notes !== undefined) changes.notesUser = blankToNull(patch.notes);

  db.transaction((tx) => {
    tx.update(transactions)
      .set({ ...changes, updatedAt: new Date().toISOString() })
      .where(eq(transactions.id, id))
      .run();
    // The merchant or recipient may now match a different rule, unless the category is the user's.
    if (source !== "manual") applyRules(tx, [id]);
  });
  return getTransaction(db, id);
}
