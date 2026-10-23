import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { OPENING_BALANCE_NAME } from "./manual-transaction.service.js";

/**
 * Reconciling an account with a statement: what the app's records say the balance was on the
 * statement's closing day, against what the statement says. The app's figure is today's balance
 * worked back through the posted transactions since that day (the same way the net worth history
 * is rebuilt). A difference points at a missing, doubled or wrongly dated transaction.
 */

export interface ReconcileLine {
  id: number;
  date: string;
  merchant: string;
  /** Positive is money out of a bank account, or more owed on a card. */
  amountMinor: number;
  pending: boolean;
}

export interface Reconciliation {
  accountId: number;
  accountName: string;
  /** `depository` (what is in it) or `credit` (what is owed on it). */
  type: "depository" | "credit";
  statementDate: string;
  /** The balance now, as the bank last reported it. */
  currentMinor: number;
  /** Posted since the statement day: worked back out of the balance. */
  sinceCount: number;
  sinceMinor: number;
  /** What the app's records say the balance was at the end of the statement day. */
  ledgerMinor: number;
  /** The statement's balance, when given. */
  statementMinor: number | null;
  /** Statement minus the app's figure; null without a statement balance. */
  differenceMinor: number | null;
  /** Posted in the last days before the statement closed: the likeliest to be off by a day. */
  nearCutoff: ReconcileLine[];
  /** Still pending: not part of either figure until they post. */
  pending: ReconcileLine[];
}

/** Transactions this many days either side of the closing day are listed as near the cutoff. */
const CUTOFF_DAYS = 3;

export function reconcileAccount(
  db: AppDb,
  accountId: number,
  statementDate: string,
  statementMinor: number | null = null,
): Reconciliation {
  if (!isRealDate(statementDate)) {
    throw new AppError(400, "invalid_date", "Enter the statement's closing day as YYYY-MM-DD.");
  }
  const account = listAccounts(db, undefined, true).find((a) => a.id === accountId);
  if (!account) throw notFound("That account");
  if (account.type !== "depository" && account.type !== "credit") {
    throw new AppError(400, "not_reconcilable", "Only bank accounts and cards can be reconciled.");
  }
  if (account.currentBalanceMinor === null) {
    throw new AppError(400, "no_balance", "This account has no balance to start from yet.");
  }

  const lines = db.all<{
    id: number;
    date: string;
    merchant: string;
    amountMinor: number;
    pending: number;
  }>(sql`
    select id, date, coalesce(merchant_name_user, merchant_name, name) as merchant,
      amount_minor as amountMinor, pending
    from transactions
    where account_id = ${accountId}
      -- A hand-kept account's opening balance stands for everything before it, whatever its date.
      and not (source = 'manual' and name = ${OPENING_BALANCE_NAME})
      and (pending = 1 or date >= ${addDays(statementDate, -CUTOFF_DAYS)})
    order by date desc, id desc`);
  const toLine = (r: (typeof lines)[number]): ReconcileLine => ({
    id: r.id,
    date: r.date,
    merchant: r.merchant,
    amountMinor: r.amountMinor,
    pending: r.pending === 1,
  });
  const since = lines.filter((r) => r.pending === 0 && r.date > statementDate);
  const sinceMinor = since.reduce((n, r) => n + r.amountMinor, 0);
  // Money out lowers a bank balance but raises what a card owes.
  const ledgerMinor =
    account.type === "credit"
      ? account.currentBalanceMinor - sinceMinor
      : account.currentBalanceMinor + sinceMinor;

  return {
    accountId,
    accountName: account.name,
    type: account.type,
    statementDate,
    currentMinor: account.currentBalanceMinor,
    sinceCount: since.length,
    sinceMinor,
    ledgerMinor,
    statementMinor,
    differenceMinor: statementMinor === null ? null : statementMinor - ledgerMinor,
    nearCutoff: lines
      .filter(
        (r) =>
          r.pending === 0 &&
          r.date <= addDays(statementDate, CUTOFF_DAYS) &&
          r.date >= addDays(statementDate, -CUTOFF_DAYS),
      )
      .map(toLine),
    pending: lines.filter((r) => r.pending === 1).map(toLine),
  };
}
