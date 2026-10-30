import { and, asc, eq, sql } from "drizzle-orm";
import { accounts, balanceSnapshots, categories, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { accountColor } from "./account.service.js";
import { addManualCreditLimit } from "./credit-limit.service.js";
import { applyRules } from "./rule.service.js";
import { detectInternalTransfers } from "./transfer.service.js";
import {
  getTransaction,
  updateTransaction,
  type TransactionDto,
  type TransactionPatch,
} from "./transaction.service.js";

/**
 * Accounts and transactions the user keeps by hand: a cash wallet, an account at a bank that
 * cannot be connected, a card, and so on. A hand-kept account's balance is never typed in; it is
 * the total of its transactions (money in minus money out, or the amount owed for a card), so the
 * balance and the history can never disagree. An opening balance is just a first transaction.
 *
 * Signs follow the bank convention used everywhere: `amount_minor` is positive when money LEAVES
 * the account (or, on a card, when a purchase raises what is owed).
 */

import { STORE_CREDIT_SUBTYPE } from "./account-scope.js";
export { STORE_CREDIT_SUBTYPE };

/** `store_credit`: dollar credits held for one business or service (a Dunkin gift card, say). */
export const MANUAL_ACCOUNT_KINDS = [
  "cash",
  "checking",
  "savings",
  "credit_card",
  "loan",
  "store_credit",
  "collection",
  "pokemon_cards",
] as const;
export type ManualAccountKind = (typeof MANUAL_ACCOUNT_KINDS)[number];

/** The subtype of a collection account (cards and other collectibles, valued item by item). */
export const COLLECTION_SUBTYPE = "collection";
/** A collection of Pokemon cards: each card has a TCGplayer id and a condition, and market prices. */
export const POKEMON_COLLECTION_SUBTYPE = "pokemon cards";
export const COLLECTION_SUBTYPES: ReadonlySet<string> = new Set([
  COLLECTION_SUBTYPE,
  POKEMON_COLLECTION_SUBTYPE,
]);

const KIND: Record<
  ManualAccountKind,
  { type: "depository" | "credit" | "loan" | "other"; subtype: string }
> = {
  cash: { type: "depository", subtype: "cash" },
  checking: { type: "depository", subtype: "checking" },
  savings: { type: "depository", subtype: "savings" },
  credit_card: { type: "credit", subtype: "credit card" },
  // A car, student or personal loan from a lender that cannot be connected: kept like a card.
  loan: { type: "loan", subtype: "loan" },
  store_credit: { type: "depository", subtype: STORE_CREDIT_SUBTYPE },
  // Worth what its items are worth: no transactions, so no opening balance.
  collection: { type: "other", subtype: COLLECTION_SUBTYPE },
  pokemon_cards: { type: "other", subtype: POKEMON_COLLECTION_SUBTYPE },
};

const MAX_AMOUNT = 100_000_000_000;

/**
 * A card's or loan's balance is what is owed: a charge (or interest) raises it and a payment
 * lowers it. A deposit account's balance is what is in it, the other way round.
 */
const owes = (type: string): boolean => type === "credit" || type === "loan";
export const OPENING_BALANCE_NAME = "Opening balance";

type Tx = Pick<AppDb, "select" | "insert" | "update" | "delete">;

/** Manual balance observations are derived from the editable ledger, not independent bank readings. */
export function rebuildManualBalanceHistory(db: Tx, accountId: number): void {
  const account = db
    .select({ type: accounts.type })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) return;
  const flows = db
    .select({ date: transactions.date, amount: transactions.amountMinor })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.pending, false)))
    .orderBy(asc(transactions.date))
    .all();
  const snapshots = db
    .select({
      id: balanceSnapshots.id,
      observedAt: balanceSnapshots.observedAt,
      balance: balanceSnapshots.currentBalanceMinor,
    })
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.accountId, accountId))
    .orderBy(asc(balanceSnapshots.observedAt))
    .all();
  let total = 0;
  let position = 0;
  for (const snapshot of snapshots) {
    const day = snapshot.observedAt.slice(0, 10);
    while (position < flows.length && flows[position]!.date <= day) {
      total += flows[position++]!.amount;
    }
    const balance = owes(account.type) ? total : -total;
    if (snapshot.balance !== balance) {
      db.update(balanceSnapshots)
        .set({ currentBalanceMinor: balance })
        .where(eq(balanceSnapshots.id, snapshot.id))
        .run();
    }
  }
}

/** Repairs observations left by earlier versions, without changing investment or collection history. */
export function repairManualBalanceHistories(db: AppDb): void {
  db.transaction((tx) => {
    const rows = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.isManual, true), sql`${accounts.type} in ('depository', 'credit', 'loan')`),
      )
      .all();
    for (const row of rows) {
      rebuildManualBalanceHistory(tx, row.id);
      // Older versions included pending charges in the current balance as well as its history.
      tx.update(accounts)
        .set({
          currentBalanceMinor: sql`(case when ${accounts.type} in ('credit', 'loan') then 1 else -1 end) *
        (select coalesce(sum(amount_minor), 0) from transactions where account_id = ${row.id} and pending = 0)`,
        })
        .where(eq(accounts.id, row.id))
        .run();
    }
  });
}

interface ManualBankAccount {
  id: number;
  type: string;
  currency: string;
}

/** The account must be one the user keeps by hand and that holds ordinary transactions. */
function requireManualBankAccount(db: Pick<AppDb, "select">, accountId: number): ManualBankAccount {
  const account = db
    .select({
      id: accounts.id,
      type: accounts.type,
      currency: accounts.currency,
      isManual: accounts.isManual,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) throw notFound("That account");
  if (!account.isManual || (account.type !== "depository" && !owes(account.type))) {
    throw new AppError(
      409,
      "not_manual_account",
      "Transactions can only be added by hand to an account you keep by hand, such as a cash account. Connected accounts fill in from the bank.",
    );
  }
  return account;
}

/** Sets a hand-kept account's balance to what its transactions add up to, and records the point. */
export function recomputeManualBalance(db: Tx, accountId: number, now: string): void {
  const account = db
    .select({ type: accounts.type, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) return;
  const total =
    db
      .select({ sum: sql<number>`coalesce(sum(${transactions.amountMinor}), 0)` })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), eq(transactions.pending, false)))
      .get()?.sum ?? 0;
  // Money in raises a deposit account; a purchase raises what is owed on a card or loan.
  const balance = owes(account.type) ? total : -total;
  db.update(accounts)
    .set({ currentBalanceMinor: balance, lastBalanceUpdateAt: now, updatedAt: now })
    .where(eq(accounts.id, accountId))
    .run();
  db.insert(balanceSnapshots)
    .values({
      accountId,
      observedAt: now,
      currentBalanceMinor: balance,
      availableBalanceMinor: null,
      currency: account.currency,
    })
    .run();
  rebuildManualBalanceHistory(db, accountId);
}

export interface ManualBankAccountInput {
  name: string;
  kind: ManualAccountKind;
  /** What the account holds today (a card: what is owed). May be negative for an overdrawn account. */
  openingBalanceMinor?: number | undefined;
  /** For a card: its credit limit. */
  creditLimitMinor?: number | undefined;
}

export function createManualBankAccount(
  db: AppDb,
  input: ManualBankAccountInput,
  now: string,
): number {
  const name = input.name.trim();
  if (!name) throw new AppError(400, "invalid_name", "Give the account a name.");
  const kind = KIND[input.kind];
  const opening = input.openingBalanceMinor ?? 0;
  if (!Number.isInteger(opening) || Math.abs(opening) > MAX_AMOUNT) {
    throw new AppError(400, "invalid_amount", "The opening balance is not a valid amount.");
  }
  if ((input.kind === "collection" || input.kind === "pokemon_cards") && opening !== 0) {
    throw new AppError(
      400,
      "invalid_amount",
      "A collection is worth what its items are worth; add the items instead of a balance.",
    );
  }
  if (input.creditLimitMinor !== undefined && input.kind !== "credit_card") {
    throw new AppError(400, "invalid_limit", "Only a credit card has a credit limit.");
  }
  const id = db.transaction((tx) => {
    const created = tx
      .insert(accounts)
      .values({
        plaidItemId: null,
        plaidAccountId: null,
        name,
        type: kind.type,
        subtype: kind.subtype,
        currency: "USD",
        currentBalanceMinor: 0,
        lastBalanceUpdateAt: now,
        isManual: true,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: accounts.id })
      .get();
    tx.update(accounts)
      .set({ color: accountColor(created.id) })
      .where(eq(accounts.id, created.id))
      .run();
    if (opening !== 0) {
      tx.insert(transactions)
        .values({
          accountId: created.id,
          date: now.slice(0, 10),
          name: OPENING_BALANCE_NAME,
          merchantName: OPENING_BALANCE_NAME,
          // A deposit account that holds money received it; a card or loan that owes was charged it.
          amountMinor: owes(kind.type) ? opening : -opening,
          currency: "USD",
          pending: false,
          // Not income or spending: it is where the account starts.
          isTransfer: true,
          transferSource: "system",
          source: "manual",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    recomputeManualBalance(tx, created.id, now);
    return created.id;
  });
  if (input.creditLimitMinor !== undefined) {
    addManualCreditLimit(db, id, {
      limitMinor: input.creditLimitMinor,
      effectiveDate: now.slice(0, 10),
    });
  }
  return id;
}

/** Removes an account kept by hand, with its transactions and history. Connected accounts cannot be removed here. */
export function deleteManualBankAccount(db: AppDb, accountId: number): void {
  const row = db
    .select({ isManual: accounts.isManual, subtype: accounts.subtype })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  // A collection (with its items) is removed the same way.
  if (!(row?.isManual && COLLECTION_SUBTYPES.has(row.subtype ?? "")))
    requireManualBankAccount(db, accountId);
  db.delete(accounts).where(eq(accounts.id, accountId)).run();
}

export interface ManualTransactionInput {
  accountId: number;
  date: string;
  merchant: string;
  /** What the bank would print, if different from the merchant; defaults to the merchant. */
  description?: string | null | undefined;
  /** A positive amount; `direction` says which way the money moved. */
  amountMinor: number;
  direction: "out" | "in";
  categoryId?: number | null | undefined;
  recipient?: string | null | undefined;
  sender?: string | null | undefined;
  notes?: string | null | undefined;
  pending?: boolean | undefined;
  /** Money moving between the user's own accounts (such as cash taken from an ATM): not income or spending. */
  isTransfer?: boolean | undefined;
}

const clean = (text: string | null | undefined): string | null => {
  const t = text?.trim() ?? "";
  return t === "" ? null : t;
};

function checkAmount(amountMinor: number): void {
  if (!Number.isInteger(amountMinor) || amountMinor < 1 || amountMinor > MAX_AMOUNT) {
    throw new AppError(
      400,
      "invalid_amount",
      "Enter the amount as a positive number; choose money in or money out separately.",
    );
  }
}

function checkDate(date: string): void {
  if (!isRealDate(date)) {
    throw new AppError(400, "invalid_date", "Enter a real date as YYYY-MM-DD.");
  }
}

function requireUsableCategory(db: Pick<AppDb, "select">, categoryId: number): void {
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

export function createManualTransaction(
  db: AppDb,
  input: ManualTransactionInput,
  now: string,
): TransactionDto {
  const account = requireManualBankAccount(db, input.accountId);
  const merchant = clean(input.merchant);
  if (!merchant) throw new AppError(400, "invalid_merchant", "Enter who the payment was with.");
  checkDate(input.date);
  checkAmount(input.amountMinor);
  if (input.categoryId) requireUsableCategory(db, input.categoryId);

  const id = db.transaction((tx) => {
    const created = tx
      .insert(transactions)
      .values({
        accountId: account.id,
        date: input.date,
        name: clean(input.description) ?? merchant,
        merchantName: merchant,
        amountMinor: input.direction === "out" ? input.amountMinor : -input.amountMinor,
        currency: account.currency,
        pending: input.pending ?? false,
        // The people are the user's own entries, so they live where user edits live.
        recipientUser: input.direction === "out" ? clean(input.recipient) : null,
        senderUser: input.direction === "in" ? clean(input.sender) : null,
        notesUser: clean(input.notes),
        isTransfer: input.isTransfer ?? false,
        transferSource: input.isTransfer ? "manual" : null,
        categoryId: input.categoryId ?? null,
        categorySource: input.categoryId ? "manual" : null,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: transactions.id })
      .get();
    // With no category chosen, the rules get a go, exactly as for a bank transaction.
    if (!input.categoryId) applyRules(tx, [created.id]);
    recomputeManualBalance(tx, account.id, now);
    return created.id;
  });
  // It may be one side of a transfer between the user's own accounts (a cash withdrawal, say).
  detectInternalTransfers(db, now);
  return getTransaction(db, id);
}

/** What can be changed on a transaction entered by hand, on top of the fields any transaction allows. */
export interface ManualTransactionPatch extends TransactionPatch {
  accountId?: number | undefined;
  date?: string | undefined;
  description?: string | null | undefined;
  amountMinor?: number | undefined;
  direction?: "out" | "in" | undefined;
  pending?: boolean | undefined;
}

const MANUAL_ONLY_FIELDS = [
  "accountId",
  "date",
  "description",
  "amountMinor",
  "direction",
  "pending",
] as const;

function requireManualRow(db: Pick<AppDb, "select">, id: number) {
  const row = db
    .select({
      id: transactions.id,
      source: transactions.source,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      date: transactions.date,
      pending: transactions.pending,
      transferSource: transactions.transferSource,
      transferPairId: transactions.transferPairId,
    })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!row) throw notFound("That transaction");
  return row;
}

/**
 * Edits a transaction. Anyone's transaction can have its category, merchant name, people, and notes
 * changed; the rest (date, amount, account, ...) comes from the bank, so only a transaction the user
 * entered can change those.
 */
export function updateAnyTransaction(
  db: AppDb,
  id: number,
  patch: ManualTransactionPatch,
  now: string = new Date().toISOString(),
): TransactionDto {
  // Include category/transfer validation and detection in the same commit as ledger and balance edits.
  return db.transaction((tx) =>
    updateAnyTransactionInTransaction(tx as unknown as AppDb, id, patch, now),
  );
}

function updateAnyTransactionInTransaction(
  db: AppDb,
  id: number,
  patch: ManualTransactionPatch,
  now: string,
): TransactionDto {
  const row = requireManualRow(db, id);
  const wantsManualOnly = MANUAL_ONLY_FIELDS.some((f) => patch[f] !== undefined);
  if (row.source !== "manual") {
    if (wantsManualOnly) {
      throw new AppError(
        409,
        "bank_transaction",
        "The date, amount, and account of a bank transaction come from the bank and cannot be changed. You can still change its category, merchant name, people, and notes.",
      );
    }
    return updateTransaction(db, id, patch);
  }

  const changes: Partial<typeof transactions.$inferInsert> = {};
  const touched = new Set<number>([row.accountId]);

  if (patch.accountId !== undefined && patch.accountId !== row.accountId) {
    const target = requireManualBankAccount(db, patch.accountId);
    changes.accountId = target.id;
    changes.currency = target.currency;
    touched.add(target.id);
  }
  if (patch.date !== undefined) {
    checkDate(patch.date);
    changes.date = patch.date;
  }
  if (patch.description !== undefined) {
    const name = clean(patch.description);
    if (name) changes.name = name;
  }
  if (patch.pending !== undefined) changes.pending = patch.pending;
  if (patch.amountMinor !== undefined || patch.direction !== undefined) {
    const amount = patch.amountMinor ?? Math.abs(row.amountMinor);
    checkAmount(amount);
    const direction = patch.direction ?? (row.amountMinor > 0 ? "out" : "in");
    changes.amountMinor = direction === "out" ? amount : -amount;
  }
  if (
    row.transferSource === "manual" &&
    row.transferPairId !== null &&
    ((changes.accountId !== undefined && changes.accountId !== row.accountId) ||
      (changes.date !== undefined && changes.date !== row.date) ||
      (changes.amountMinor !== undefined && changes.amountMinor !== row.amountMinor) ||
      (changes.pending !== undefined && changes.pending !== row.pending))
  ) {
    throw new AppError(
      409,
      "linked_transfer",
      "Unlink this transfer before changing its account, date, amount, direction, or pending status.",
    );
  }
  // For a transaction entered by hand the merchant is simply its name, not an override of a bank's.
  if (patch.merchant !== undefined) {
    const merchant = clean(patch.merchant);
    if (!merchant) throw new AppError(400, "invalid_merchant", "Enter who the payment was with.");
    changes.merchantName = merchant;
    changes.merchantNameUser = null;
  }

  db.transaction((tx) => {
    if (Object.keys(changes).length > 0) {
      tx.update(transactions)
        .set({ ...changes, updatedAt: now })
        .where(eq(transactions.id, id))
        .run();
    }
    for (const accountId of touched) recomputeManualBalance(tx, accountId, now);
  });
  // A new date, amount, or account may pair it with a transaction on another account.
  detectInternalTransfers(db, now);

  // The remaining fields (category, people, notes, transfer) are saved the usual way.
  const rest: TransactionPatch = {
    categoryId: patch.categoryId,
    recipient: patch.recipient,
    sender: patch.sender,
    notes: patch.notes,
    online: patch.online,
    isTransfer: patch.isTransfer,
  };
  if (Object.values(rest).some((v) => v !== undefined)) return updateTransaction(db, id, rest);
  return getTransaction(db, id);
}

/** Deletes a transaction the user entered. Bank transactions cannot be deleted. */
export function deleteManualTransaction(
  db: AppDb,
  id: number,
  now: string = new Date().toISOString(),
): void {
  const row = requireManualRow(db, id);
  if (row.source !== "manual") {
    throw new AppError(
      409,
      "bank_transaction",
      "A bank transaction cannot be deleted, because the next sync would bring it back.",
    );
  }
  db.transaction((tx) => {
    tx.delete(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.source, "manual")))
      .run();
    // A transfer it was linked with by hand stays a transfer, just no longer linked.
    tx.update(transactions)
      .set({ transferPairId: null, updatedAt: now })
      .where(and(eq(transactions.transferPairId, id), eq(transactions.transferSource, "manual")))
      .run();
    recomputeManualBalance(tx, row.accountId, now);
  });
  detectInternalTransfers(db, now);
}
