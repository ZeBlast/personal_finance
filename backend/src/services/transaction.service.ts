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
  transactionSplits,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { STORE_CREDIT_SUBTYPE } from "./account-scope.js";
import type { GatewayTransaction } from "../plaid/gateway.js";
import { AppError, notFound } from "../utils/errors.js";
import { toMinorUnits } from "../utils/money.js";
import { extractRecipient } from "./recipient.js";
import { applyRules, getDiningSplit, isOnline, splitCategory } from "./rule.service.js";
import { setTransferFlag, syncCategoryTransfers } from "./transfer.service.js";

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

  const person = extractRecipient({
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
    counterpartiesJson: t.counterparties.length > 0 ? JSON.stringify(t.counterparties) : null,
    datetime: t.datetime ?? null,
    authorizedDatetime: t.authorizedDatetime ?? null,
    originalDescription: t.originalDescription ?? null,
    locationAddress: t.location?.address ?? null,
    locationCity: t.location?.city ?? null,
    locationRegion: t.location?.region ?? null,
    locationPostalCode: t.location?.postalCode ?? null,
    locationCountry: t.location?.country ?? null,
    locationLat: t.location?.lat ?? null,
    locationLon: t.location?.lon ?? null,
    locationStoreNumber: t.location?.storeNumber ?? null,
    merchantEntityId: t.merchantEntityId ?? null,
    merchantCategoryCode: t.merchantCategoryCode ?? null,
    logoUrl: t.logoUrl ?? null,
    website: t.website ?? null,
    categoryConfidence: t.categoryConfidence ?? null,
    paymentMethod: t.payment?.method ?? null,
    paymentProcessor: t.payment?.processor ?? null,
    paymentReference: t.payment?.reference ?? null,
    paymentReason: t.payment?.reason ?? null,
    paymentByOrderOf: t.payment?.byOrderOf ?? null,
    paymentPpdId: t.payment?.ppdId ?? null,
    // The other party is the recipient of money going out and the sender of money coming in.
    recipient: amountMinor > 0 ? (person?.recipient ?? null) : null,
    recipientSource: amountMinor > 0 ? (person?.source ?? null) : null,
    sender: amountMinor <= 0 ? (person?.recipient ?? null) : null,
    senderSource: amountMinor <= 0 ? (person?.source ?? null) : null,
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
    // Whether it is a transfer between the user's own accounts is decided separately, so a
    // refresh from the provider never undoes it.
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
  "txdate_desc",
  "txdate_asc",
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
  /**
   * Show the page that holds this transaction (with the same filters and sort) instead of `page`,
   * when it is in the list at all.
   */
  focus?: number | undefined;
  accountId?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  pending?: boolean | undefined;
  /** Only purchases that were (true) or were not (false) bought online, by the user's call or the bank's. */
  online?: boolean | undefined;
  /** An institution by name, or "manual" for accounts kept by hand. */
  institution?: string | undefined;
  /** Which date `from` and `to` apply to (default: the transaction date). */
  dateBasis?: "transaction" | "posted" | undefined;
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

export interface SplitDto {
  id: number;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  /** Same sign as the transaction: positive is money out. */
  amountMinor: number;
  note: string | null;
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
  /** Who sent the money, for money coming in: the user's edit, else the provider/parsed value. */
  sender: string | null;
  senderSource: "plaid" | "parsed" | "manual" | null;
  providerSender: string | null;
  /** `manual` for a transaction entered by hand, which can be edited in full. */
  source: "plaid" | "manual";
  /** A transfer between the user's own accounts: neither income nor spending. */
  isTransfer: boolean;
  /** Who decided: `auto` (matched with the other side), `manual` (the user), `system`, or null. */
  transferSource: "auto" | "manual" | "system" | "category" | null;
  /**
   * The parts it is split into across categories (empty when it is not split). `valid` is false when
   * they no longer add up to the amount (the bank changed it), and the transaction counts whole.
   */
  splits: SplitDto[];
  splitValid: boolean;
  /** For an automatic match, the other side of the transfer. */
  transferWith: {
    id: number;
    accountName: string;
    institutionName: string | null;
    /** `credit`, `loan`, `depository`, ... of the other side's account. */
    accountType: string;
    date: string;
    /** When the other side was made (its authorized date, else its posted date). */
    transactionDate: string;
    merchant: string;
  } | null;
  /** `credit`, `loan`, `depository`, ... of this transaction's account. */
  accountType: string;
  paymentChannel: string | null;
  /** Whether it was an online purchase: the user's call if there is one, else the bank's channel. */
  online: boolean;
  /** True when the user set `online` by hand (the bank's value is in `providerOnline`). */
  onlineEdited: boolean;
  /** What the bank's payment channel says: true online, false in store, null when it does not say. */
  providerOnline: boolean | null;
  notes: string | null;
  /** What Plaid sent beyond the basics; every part may be null. */
  details: TransactionDetails;
}

export interface TransactionDetails {
  datetime: string | null;
  authorizedDatetime: string | null;
  /** The bank's own wording, before cleanup. */
  originalDescription: string | null;
  location: {
    address: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    lat: number | null;
    lon: number | null;
    storeNumber: string | null;
  } | null;
  merchant: {
    entityId: string | null;
    categoryCode: string | null;
    logoUrl: string | null;
    website: string | null;
  } | null;
  categoryConfidence: string | null;
  payment: {
    method: string | null;
    processor: string | null;
    reference: string | null;
    reason: string | null;
    byOrderOf: string | null;
    ppdId: string | null;
  } | null;
  counterparties: Array<{
    name: string;
    type: string;
    entityId: string | null;
    website: string | null;
    logoUrl: string | null;
    confidenceLevel: string | null;
  }>;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

const effectiveMerchant = sql`lower(coalesce(nullif(trim(${transactions.merchantNameUser}), ''), ${transactions.merchantName}, ${transactions.name}))`;

const selectColumns = {
  id: transactions.id,
  accountId: transactions.accountId,
  accountName: accounts.name,
  accountType: accounts.type,
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
  sender: transactions.sender,
  senderSource: transactions.senderSource,
  senderUser: transactions.senderUser,
  source: transactions.source,
  isTransfer: transactions.isTransfer,
  transferSource: transactions.transferSource,
  transferPairId: transactions.transferPairId,
  paymentChannel: transactions.paymentChannel,
  counterpartyName: transactions.counterpartyName,
  counterpartyType: transactions.counterpartyType,
  counterpartiesJson: transactions.counterpartiesJson,
  datetime: transactions.datetime,
  authorizedDatetime: transactions.authorizedDatetime,
  originalDescription: transactions.originalDescription,
  locationAddress: transactions.locationAddress,
  locationCity: transactions.locationCity,
  locationRegion: transactions.locationRegion,
  locationPostalCode: transactions.locationPostalCode,
  locationCountry: transactions.locationCountry,
  locationLat: transactions.locationLat,
  locationLon: transactions.locationLon,
  locationStoreNumber: transactions.locationStoreNumber,
  merchantEntityId: transactions.merchantEntityId,
  merchantCategoryCode: transactions.merchantCategoryCode,
  logoUrl: transactions.logoUrl,
  website: transactions.website,
  categoryConfidence: transactions.categoryConfidence,
  paymentMethod: transactions.paymentMethod,
  paymentProcessor: transactions.paymentProcessor,
  paymentReference: transactions.paymentReference,
  paymentReason: transactions.paymentReason,
  paymentByOrderOf: transactions.paymentByOrderOf,
  paymentPpdId: transactions.paymentPpdId,
  notesUser: transactions.notesUser,
  onlineUser: transactions.onlineUser,
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
  const manualSender = r.senderUser?.trim() ? r.senderUser : null;
  const manualMerchant = r.merchantNameUser?.trim() ? r.merchantNameUser : null;
  const providerMerchant = r.merchantName || r.name;
  const providerOnline =
    r.paymentChannel === "online" ? true : r.paymentChannel === "in store" ? false : null;
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    accountType: r.accountType,
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
    sender: manualSender ?? r.sender,
    senderSource: manualSender ? "manual" : (r.senderSource as "plaid" | "parsed" | null),
    providerSender: r.sender,
    source: r.source === "manual" ? "manual" : "plaid",
    isTransfer: r.isTransfer,
    transferSource: r.transferSource as TransactionDto["transferSource"],
    transferWith: null,
    splits: [],
    splitValid: true,
    paymentChannel: r.paymentChannel,
    online: r.onlineUser ?? providerOnline === true,
    onlineEdited: r.onlineUser !== null,
    providerOnline,
    notes: r.notesUser,
    details: detailsOf(r),
  };
}

const anyOf = <T extends Record<string, unknown>>(value: T): T | null =>
  Object.values(value).some((v) => v !== null) ? value : null;

function parseCounterparties(json: string | null): TransactionDetails["counterparties"] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as Array<Record<string, unknown>>;
    return list.map((c) => ({
      name: String(c["name"] ?? ""),
      type: String(c["type"] ?? ""),
      entityId: (c["entityId"] as string | null | undefined) ?? null,
      website: (c["website"] as string | null | undefined) ?? null,
      logoUrl: (c["logoUrl"] as string | null | undefined) ?? null,
      confidenceLevel: (c["confidenceLevel"] as string | null | undefined) ?? null,
    }));
  } catch {
    return [];
  }
}

function detailsOf(r: Row): TransactionDetails {
  return {
    datetime: r.datetime,
    authorizedDatetime: r.authorizedDatetime,
    originalDescription: r.originalDescription,
    location: anyOf({
      address: r.locationAddress,
      city: r.locationCity,
      region: r.locationRegion,
      postalCode: r.locationPostalCode,
      country: r.locationCountry,
      lat: r.locationLat,
      lon: r.locationLon,
      storeNumber: r.locationStoreNumber,
    }),
    merchant: anyOf({
      entityId: r.merchantEntityId,
      categoryCode: r.merchantCategoryCode,
      logoUrl: r.logoUrl,
      website: r.website,
    }),
    categoryConfidence: r.categoryConfidence,
    payment: anyOf({
      method: r.paymentMethod,
      processor: r.paymentProcessor,
      reference: r.paymentReference,
      reason: r.paymentReason,
      byOrderOf: r.paymentByOrderOf,
      ppdId: r.paymentPpdId,
    }),
    counterparties: parseCounterparties(r.counterpartiesJson),
  };
}

/** When the purchase was made: the authorized date, else the posted date. */
const transactionDate = sql<string>`coalesce(${transactions.authorizedDate}, ${transactions.date})`;

function orderBy(sort: Sort): SQL[] {
  const tieBreak = [desc(transactionDate), desc(transactions.date), desc(transactions.id)];
  switch (sort) {
    case "date_desc":
      return [desc(transactions.date), desc(transactions.id)];
    case "txdate_asc":
      return [asc(transactionDate), asc(transactions.date), asc(transactions.id)];
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

/** A search that reads as an amount ("54.11", "$1,200", "12"), in cents, or null. */
export function amountQuery(q: string | undefined): number | null {
  const text = (q ?? "")
    .trim()
    .replace(/^[-+]?\$?/, "")
    .replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

export function listTransactions(
  db: AppDb,
  query: TransactionQuery,
): { items: TransactionDto[]; total: number; page: number; pageSize: number } {
  const conditions: SQL[] = [
    or(eq(plaidItems.environment, query.environment), sql`${accounts.plaidItemId} IS NULL`)!,
  ];
  // Hidden and store credit accounts stay out of the list, unless one is asked for by name.
  if (query.accountId === undefined) {
    conditions.push(eq(accounts.hidden, false));
    conditions.push(sql`coalesce(${accounts.subtype}, '') <> ${STORE_CREDIT_SUBTYPE}`);
  } else conditions.push(eq(transactions.accountId, query.accountId));
  // From/to use the transaction date, unless the posted date is asked for.
  const day: SQL<string> =
    query.dateBasis === "posted" ? sql<string>`${transactions.date}` : transactionDate;
  if (query.from) conditions.push(gte(day, query.from));
  if (query.to) conditions.push(lte(day, query.to));
  if (query.pending !== undefined) conditions.push(eq(transactions.pending, query.pending));
  if (query.institution === "manual") conditions.push(isNull(accounts.plaidItemId));
  else if (query.institution !== undefined) {
    conditions.push(eq(plaidItems.institutionName, query.institution));
  }
  if (query.online !== undefined) {
    const isOnline = sql`coalesce(${transactions.onlineUser}, ${transactions.paymentChannel} = 'online', 0)`;
    conditions.push(query.online ? sql`${isOnline} = 1` : sql`${isOnline} = 0`);
  }
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
    // A split transaction matches when any of its parts is in the category.
    conditions.push(
      or(
        inArray(transactions.categoryId, ids),
        sql`exists (select 1 from transaction_splits s where s.transaction_id = ${transactions.id}
          and s.category_id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}))`,
      )!,
    );
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
        matches(transactions.sender),
        matches(transactions.senderUser),
        matches(transactions.notesUser),
        matches(categories.name),
        // A search that is an amount ("54.11", "$1,200") also finds that amount, either way.
        ...(amountQuery(query.q) === null
          ? []
          : [sql`abs(${transactions.amountMinor}) = ${amountQuery(query.q)}`]),
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

  let page = query.page;
  if (query.focus !== undefined) {
    const order = db
      .select({ id: transactions.id })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(plaidItems, eq(accounts.plaidItemId, plaidItems.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(where)
      .orderBy(...orderBy(query.sort ?? "txdate_desc"))
      .all();
    const at = order.findIndex((r) => r.id === query.focus);
    if (at >= 0) page = Math.floor(at / query.pageSize) + 1;
  }

  const rows = selectTransactions(db)
    .where(where)
    .orderBy(...orderBy(query.sort ?? "txdate_desc"))
    .limit(query.pageSize)
    .offset((page - 1) * query.pageSize)
    .all();

  return {
    items: withTransferPartners(db, rows),
    total,
    page,
    pageSize: query.pageSize,
  };
}

export function getTransaction(db: AppDb, id: number): TransactionDto {
  const row = selectTransactions(db).where(eq(transactions.id, id)).get();
  if (!row) throw notFound("That transaction");
  return withTransferPartners(db, [row])[0]!;
}

/** Turns rows into DTOs, naming the other side of each automatically matched transfer. */
/** The split parts of these transactions, in order. */
function splitsFor(db: AppDb, ids: number[]): Map<number, SplitDto[]> {
  const out = new Map<number, SplitDto[]>();
  if (ids.length === 0) return out;
  const rows = db
    .select({
      id: transactionSplits.id,
      transactionId: transactionSplits.transactionId,
      categoryId: transactionSplits.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      amountMinor: transactionSplits.amountMinor,
      note: transactionSplits.note,
    })
    .from(transactionSplits)
    .leftJoin(categories, eq(categories.id, transactionSplits.categoryId))
    .where(inArray(transactionSplits.transactionId, ids))
    .orderBy(asc(transactionSplits.position), asc(transactionSplits.id))
    .all();
  for (const { transactionId, ...split } of rows) {
    const list = out.get(transactionId);
    if (list) list.push(split);
    else out.set(transactionId, [split]);
  }
  return out;
}

function withTransferPartners(db: AppDb, rows: Row[]): TransactionDto[] {
  const ids = [
    ...new Set(rows.map((r) => r.transferPairId).filter((id): id is number => id !== null)),
  ];
  const partners = new Map<number, NonNullable<TransactionDto["transferWith"]>>();
  if (ids.length > 0) {
    for (const p of selectTransactions(db).where(inArray(transactions.id, ids)).all()) {
      partners.set(p.id, {
        id: p.id,
        accountName: p.accountName,
        institutionName: p.institutionName,
        accountType: p.accountType,
        date: p.date,
        transactionDate: p.authorizedDate ?? p.date,
        merchant: toDto(p).merchant,
      });
    }
  }
  const splits = splitsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const dto = toDto(r);
    dto.transferWith = r.transferPairId === null ? null : (partners.get(r.transferPairId) ?? null);
    dto.splits = splits.get(r.id) ?? [];
    dto.splitValid =
      dto.splits.length === 0 ||
      dto.splits.reduce((n, s) => n + s.amountMinor, 0) === r.amountMinor;
    return dto;
  });
}

// ---- Editing ---------------------------------------------------------------------------

export interface TransactionPatch {
  /** A category ID to assign by hand, or null to clear it and let the rules decide. */
  categoryId?: number | null | undefined;
  /** Text to show instead of the bank's merchant; null or empty goes back to the bank's. */
  merchant?: string | null | undefined;
  /** The person on the other side of a transfer; null or empty goes back to the detected one. */
  recipient?: string | null | undefined;
  /** Who sent the money (for money coming in); null or empty goes back to the detected one. */
  sender?: string | null | undefined;
  notes?: string | null | undefined;
  /** Whether this was an online purchase: true or false is the user's call; null goes back to the bank's. */
  online?: boolean | null | undefined;
  /**
   * Whether this is a transfer between the user's own accounts (so it is not counted as income or
   * spending). `null` lets the app decide again by matching it with the other side.
   */
  isTransfer?: boolean | null | undefined;
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
    .select({
      categorySource: transactions.categorySource,
      categoryId: transactions.categoryId,
      onlineUser: transactions.onlineUser,
      paymentChannel: transactions.paymentChannel,
    })
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
  if (patch.sender !== undefined) changes.senderUser = blankToNull(patch.sender);
  if (patch.notes !== undefined) changes.notesUser = blankToNull(patch.notes);
  if (patch.online !== undefined) {
    // The bank's answer is always kept; the user's is stored only while it differs from it.
    const bankSays = current.paymentChannel === "online";
    changes.onlineUser = patch.online === null || patch.online === bankSays ? null : patch.online;
    // A category chosen by hand still follows the online flag between Food & Drink and Dining Out.
    if (source === "manual" && patch.categoryId === undefined) {
      const online = isOnline({ onlineUser: patch.online, paymentChannel: current.paymentChannel });
      const next = splitCategory(getDiningSplit(db), current.categoryId, online);
      if (next !== current.categoryId) changes.categoryId = next;
    }
  }

  db.transaction((tx) => {
    tx.update(transactions)
      .set({ ...changes, updatedAt: new Date().toISOString() })
      .where(eq(transactions.id, id))
      .run();
    // The merchant or recipient may now match a different rule, unless the category is the user's.
    if (source !== "manual") applyRules(tx, [id]);
  });
  // A new category may move the user's own money; the user's own transfer choice comes after.
  syncCategoryTransfers(db);
  if (patch.isTransfer !== undefined) setTransferFlag(db, id, patch.isTransfer);
  return getTransaction(db, id);
}
