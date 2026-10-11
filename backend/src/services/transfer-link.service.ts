import { eq, sql } from "drizzle-orm";
import { accounts, transactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { STORE_CREDIT_SUBTYPE } from "./account-scope.js";
import { createManualTransaction, recomputeManualBalance } from "./manual-transaction.service.js";
import { getTransaction, type TransactionDto } from "./transaction.service.js";
import { detectInternalTransfers } from "./transfer.service.js";

/**
 * Transfers to and from accounts the user keeps by hand. A bank transfer into a hand-kept account
 * (cash withdrawn into a wallet, money moved to a savings account the bank can't connect) has no
 * other side for the matching to find, because nothing is on that account until the user adds it.
 * Linking makes that other side: a transaction on the hand-kept account for the same amount, the
 * opposite way, on the same day, and pairs the two as a transfer the user decided
 * (`transfer_source = 'manual'`), so detection leaves them alone. Unlinking removes it again.
 */

function load(db: Pick<AppDb, "select">, id: number) {
  const row = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      date: transactions.date,
      authorizedDate: transactions.authorizedDate,
      transferPairId: transactions.transferPairId,
      transferSource: transactions.transferSource,
      createdForTransfer: transactions.createdForTransfer,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(eq(transactions.id, id))
    .get();
  if (!row) throw notFound("That transaction");
  return row;
}

/** Links a transfer with a hand-kept account, adding the other side there. */
export function linkTransferToAccount(
  db: AppDb,
  id: number,
  accountId: number,
  now = new Date().toISOString(),
): TransactionDto {
  const t = load(db, id);
  if (t.transferPairId !== null) {
    throw new AppError(
      409,
      "already_linked",
      "This transfer is already linked with a transaction on another account.",
    );
  }
  if (t.amountMinor === 0) throw new AppError(400, "invalid_amount", "There is no money to move.");
  if (accountId === t.accountId) {
    throw new AppError(400, "same_account", "Choose a different account for the other side.");
  }
  const target = db
    .select({
      name: accounts.name,
      isManual: accounts.isManual,
      subtype: accounts.subtype,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!target) throw notFound("That account");
  if (!target.isManual || target.subtype === STORE_CREDIT_SUBTYPE) {
    throw new AppError(
      409,
      "not_manual_account",
      "Choose an account you keep by hand, such as a cash or savings account.",
    );
  }
  if (target.currency !== t.currency) {
    throw new AppError(409, "currency_mismatch", "The two accounts use different currencies.");
  }

  const out = t.amountMinor > 0; // money left this account
  // createManualTransaction checks the account holds ordinary transactions (not a collection).
  const other = createManualTransaction(
    db,
    {
      accountId,
      date: t.authorizedDate ?? t.date,
      merchant: out ? `Transfer from ${t.accountName}` : `Transfer to ${t.accountName}`,
      amountMinor: Math.abs(t.amountMinor),
      direction: out ? "in" : "out",
      isTransfer: true,
    },
    now,
  );
  db.transaction((tx) => {
    // Same days as the original, so it lists right after it, whichever date the list sorts by.
    tx.update(transactions)
      .set({
        createdForTransfer: true,
        transferPairId: id,
        date: t.date,
        authorizedDate: t.authorizedDate,
        updatedAt: now,
      })
      .where(eq(transactions.id, other.id))
      .run();
    tx.update(transactions)
      .set({ isTransfer: true, transferSource: "manual", transferPairId: other.id, updatedAt: now })
      .where(eq(transactions.id, id))
      .run();
  });
  return getTransaction(db, id);
}

type Loaded = ReturnType<typeof load>;

/**
 * Takes a transaction out of the pair it is in, if any. What happens to its partner depends on who
 * made the pair: one the app matched is released for detection to look at again; one the app
 * added for a link by hand is removed; one the user paired by hand stays a transfer, unlinked. The
 * transaction itself is left for the caller to set.
 */
function detach(
  tx: Pick<AppDb, "select" | "insert" | "update" | "delete">,
  t: Loaded,
  now: string,
) {
  if (t.transferPairId === null) return;
  const partner = load(tx, t.transferPairId);
  if (t.transferSource === "manual" && partner.createdForTransfer) {
    tx.delete(transactions).where(eq(transactions.id, partner.id)).run();
    recomputeManualBalance(tx, partner.accountId, now);
  } else if (t.transferSource === "manual") {
    tx.update(transactions)
      .set({ transferPairId: null, updatedAt: now })
      .where(eq(transactions.id, partner.id))
      .run();
  } else {
    tx.update(transactions)
      .set({ isTransfer: false, transferSource: null, transferPairId: null, updatedAt: now })
      .where(eq(transactions.id, partner.id))
      .run();
  }
}

/**
 * Pairs two existing transactions on different accounts as the two sides of one transfer: the
 * user's choice of where the money went or came from, which replaces whatever either was paired
 * with before (see detach). The amounts may differ (a fee, or a currency conversion such as a
 * PayPal purchase in another currency), but one side must send money and the other receive it.
 */
export function pairTransfers(
  db: AppDb,
  id: number,
  otherId: number,
  now = new Date().toISOString(),
): TransactionDto {
  if (id === otherId) {
    throw new AppError(400, "same_transaction", "Choose a different transaction.");
  }
  const a = load(db, id);
  const b = load(db, otherId);
  if (a.accountId === b.accountId) {
    throw new AppError(400, "same_account", "Choose a transaction on a different account.");
  }
  if (a.currency !== b.currency) {
    throw new AppError(409, "currency_mismatch", "The two transactions use different currencies.");
  }
  if (a.amountMinor === 0 || b.amountMinor === 0 || a.amountMinor > 0 === b.amountMinor > 0) {
    throw new AppError(
      400,
      "same_direction",
      "One side of a transfer must send money and the other receive it.",
    );
  }
  if (a.createdForTransfer || b.createdForTransfer) {
    throw new AppError(
      409,
      "created_for_transfer",
      "That transaction was added for a link. Unlink it instead.",
    );
  }
  if (a.transferSource === "mirror" || b.transferSource === "mirror") {
    throw new AppError(
      409,
      "mirror_linked",
      "That transaction is a copy of a purchase another account shows. Unlink it first.",
    );
  }

  db.transaction((tx) => {
    if (a.transferPairId !== b.id) {
      detach(tx, a, now);
      detach(tx, load(tx, b.id), now); // a's partner may have been b's too
    }
    for (const [self, other] of [
      [a.id, b.id],
      [b.id, a.id],
    ] as const) {
      tx.update(transactions)
        .set({ isTransfer: true, transferSource: "manual", transferPairId: other, updatedAt: now })
        .where(eq(transactions.id, self))
        .run();
    }
  });
  detectInternalTransfers(db, now);
  return getTransaction(db, id);
}

/**
 * Undoes a pair, whoever made it, when it is wrong. The given transaction stays a transfer by the
 * user's choice, now one-sided, ready to be paired with the right one. Its partner: a transaction
 * the app added for a link by hand is removed (and its account's balance worked out again); one
 * the user paired by hand stays a transfer, unlinked; one the app matched is released for
 * detection to look at again. Given the transaction the app added, the link is undone the same way
 * from its partner's side, and null is returned since it no longer exists.
 */
export function unlinkTransfer(
  db: AppDb,
  id: number,
  now = new Date().toISOString(),
): TransactionDto | null {
  const t = load(db, id);
  if (t.transferPairId === null) {
    throw new AppError(409, "not_linked", "This transaction is not linked with another.");
  }
  if (t.createdForTransfer) {
    const partner = load(db, t.transferPairId);
    db.transaction((tx) => detach(tx, partner, now));
    db.update(transactions)
      .set({ transferPairId: null, updatedAt: now })
      .where(eq(transactions.id, partner.id))
      .run();
    detectInternalTransfers(db, now);
    return null;
  }
  db.transaction((tx) => {
    detach(tx, t, now);
    tx.update(transactions)
      .set({ isTransfer: true, transferSource: "manual", transferPairId: null, updatedAt: now })
      .where(eq(transactions.id, id))
      .run();
  });
  detectInternalTransfers(db, now);
  return getTransaction(db, id);
}

/** How far apart, in days, a suggested other side of a transfer can be. */
export const CANDIDATE_WINDOW_DAYS = 15;

export interface TransferCandidate {
  transaction: TransactionDto;
  /** The amount is exactly the opposite of the transfer's. */
  exactAmount: boolean;
  /** Days between the two transaction dates. */
  daysApart: number;
}

/**
 * Transactions that could be the other side of a transfer: on another visible account, the same
 * currency, the other direction, within CANDIDATE_WINDOW_DAYS days. Exact amounts come first, then
 * the closest amount, then the closest date. One already paired is included (pairing with it
 * replaces its pair), so a wrong automatic match can be corrected from either side.
 */
export function transferCandidates(db: AppDb, id: number, limit = 10): TransferCandidate[] {
  const t = load(db, id);
  const day = t.authorizedDate ?? t.date;
  const rows = db.all<{ id: number; exact: number; days: number }>(sql`
    select c.id, (c.amount_minor = ${-t.amountMinor}) as exact,
      abs(julianday(coalesce(c.authorized_date, c.date)) - julianday(${day})) as days
    from transactions c join accounts a on a.id = c.account_id
    where c.account_id <> ${t.accountId} and c.id <> ${id} and c.currency = ${t.currency}
      and c.created_for_transfer = 0 and a.hidden = 0
      and coalesce(c.transfer_source, '') <> 'mirror'
      and coalesce(a.subtype, '') <> ${STORE_CREDIT_SUBTYPE}
      and (c.amount_minor > 0) = ${t.amountMinor < 0 ? 1 : 0} and c.amount_minor <> 0
      and abs(julianday(coalesce(c.authorized_date, c.date)) - julianday(${day}))
        <= ${CANDIDATE_WINDOW_DAYS}
    order by exact desc, abs(c.amount_minor + ${t.amountMinor}), days, c.id
    limit ${limit}`);
  return rows.map((r) => ({
    transaction: getTransaction(db, r.id),
    exactAmount: r.exact === 1,
    daysApart: Math.round(r.days),
  }));
}
