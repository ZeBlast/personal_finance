import { desc, eq, sql } from "drizzle-orm";
import { reconciliations } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { accountCoverage, historyStart } from "./history-coverage.service.js";
import { OPENING_BALANCE_NAME } from "./manual-transaction.service.js";
import { duplicatePairs } from "./review.service.js";

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
  /** The first day of the period this check covers. */
  periodFrom: string;
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
  /** Pairs in the period that may be one purchase entered twice. */
  duplicates: Array<[ReconcileLine, ReconcileLine]>;
  /** Stretches of the period the app's records may be missing. */
  gaps: ReconcileGap[];
}

export interface ReconcileGap {
  from: string;
  to: string;
  reason: "before_history" | "not_synced" | "no_longer_shared" | "quiet";
}

/** Transactions this many days either side of the closing day are listed as near the cutoff. */
const CUTOFF_DAYS = 3;
/** A period starts the day after the last saved check when that is at most this many days back. */
const MAX_PERIOD_DAYS = 62;
const DEFAULT_PERIOD_DAYS = 30;
/** A run of this many days with nothing posted, on an account that is usually busy, is a gap. */
const QUIET_DAYS = 10;
const QUIET_LOOKBACK_DAYS = 90;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** The day after the newest saved check before this statement, if it is recent enough. */
function periodStart(db: AppDb, accountId: number, statementDate: string): string {
  const last = db
    .select({ date: reconciliations.statementDate })
    .from(reconciliations)
    .where(
      sql`${reconciliations.accountId} = ${accountId} and ${reconciliations.statementDate} < ${statementDate}`,
    )
    .orderBy(desc(reconciliations.statementDate))
    .get();
  if (last) {
    const next = addDays(last.date, 1);
    if (next >= addDays(statementDate, -MAX_PERIOD_DAYS)) return next;
  }
  return addDays(statementDate, -DEFAULT_PERIOD_DAYS);
}

/** The longest run of QUIET_DAYS or more days in from..to with no posted transaction, if any. */
function quietStretch(
  db: AppDb,
  accountId: number,
  statementDate: string,
  from: string,
  to: string,
): ReconcileGap | null {
  const busy = db.get<{ n: number }>(sql`
    select count(*) as n from transactions
    where account_id = ${accountId} and pending = 0
      and date > ${addDays(statementDate, -QUIET_LOOKBACK_DAYS)} and date <= ${statementDate}
      and not (source = 'manual' and name = ${OPENING_BALANCE_NAME})`);
  if (!busy || busy.n < QUIET_DAYS || from > to) return null;
  const posted = db.all<{ date: string }>(sql`
    select distinct date from transactions
    where account_id = ${accountId} and pending = 0 and date >= ${from} and date <= ${to}
      and not (source = 'manual' and name = ${OPENING_BALANCE_NAME})
    order by date`);
  // The empty days between two days with something posted (or the ends of the period).
  const marks = [addDays(from, -1), ...posted.map((r) => r.date), addDays(to, 1)];
  let best: ReconcileGap | null = null;
  let bestDays = 0;
  for (let i = 1; i < marks.length; i++) {
    const start = addDays(marks[i - 1]!, 1);
    const end = addDays(marks[i]!, -1);
    const days =
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
    if (days >= QUIET_DAYS && days > bestDays) {
      best = { from: start, to: end, reason: "quiet" };
      bestDays = days;
    }
  }
  return best;
}

export function reconcileAccount(
  db: AppDb,
  accountId: number,
  statementDate: string,
  statementMinor: number | null = null,
  today: string = todayIso(),
): Reconciliation {
  if (!isRealDate(statementDate)) {
    throw new AppError(400, "invalid_date", "Enter the statement's closing day as YYYY-MM-DD.");
  }
  if (statementDate > today) {
    throw new AppError(400, "future_date", "A statement can't close after today.");
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

  const periodFrom = periodStart(db, accountId, statementDate);
  const gaps: ReconcileGap[] = [];
  const start = historyStart(db, accountId);
  if (start && periodFrom < start) {
    const to = addDays(start, -1);
    gaps.push({
      from: periodFrom,
      to: to < statementDate ? to : statementDate,
      reason: "before_history",
    });
  }
  const coverage = accountCoverage(db, accountId);
  const reachesTo = coverage.through && coverage.through < statementDate ? coverage.through : null;
  if (reachesTo && coverage.reason) {
    gaps.push({
      from: reachesTo >= periodFrom ? addDays(reachesTo, 1) : periodFrom,
      to: statementDate,
      reason: coverage.reason,
    });
  }
  // Only look for a quiet stretch where the records are known to reach.
  const quiet = quietStretch(
    db,
    accountId,
    statementDate,
    start && start > periodFrom ? start : periodFrom,
    reachesTo ?? statementDate,
  );
  if (quiet) gaps.push(quiet);
  const dupLine = (id: number): ReconcileLine => {
    const r = db.get<{ date: string; merchant: string; amountMinor: number; pending: number }>(sql`
      select date, coalesce(merchant_name_user, merchant_name, name) as merchant,
        amount_minor as amountMinor, pending from transactions where id = ${id}`)!;
    return toLine({ id, ...r });
  };
  const duplicates = duplicatePairs(db, today, {
    accountId,
    from: periodFrom,
    to: statementDate,
  }).map(([a, b]): [ReconcileLine, ReconcileLine] => [dupLine(a), dupLine(b)]);

  return {
    accountId,
    accountName: account.name,
    type: account.type,
    statementDate,
    periodFrom,
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
    duplicates,
    gaps,
  };
}

/** A statement check the user saved. */
export interface ReconciliationRecord {
  id: number;
  accountId: number;
  statementDate: string;
  statementBalanceMinor: number;
  appBalanceMinor: number;
  /** Statement minus the app's figure when the check was saved. */
  differenceMinor: number;
  status: "matched" | "unresolved";
  note: string | null;
  createdAt: string;
}

function toRecord(row: typeof reconciliations.$inferSelect): ReconciliationRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    statementDate: row.statementDate,
    statementBalanceMinor: row.statementBalanceMinor,
    appBalanceMinor: row.appBalanceMinor,
    differenceMinor: row.statementBalanceMinor - row.appBalanceMinor,
    status: row.status === "matched" ? "matched" : "unresolved",
    note: row.note,
    createdAt: row.createdAt,
  };
}

/** Saves a check: matched when the statement and the app agree to the cent, otherwise unresolved. */
export function saveReconciliation(
  db: AppDb,
  input: {
    accountId: number;
    statementDate: string;
    statementBalanceMinor: number;
    note?: string | null;
  },
  now: string = new Date().toISOString(),
): ReconciliationRecord {
  const check = reconcileAccount(
    db,
    input.accountId,
    input.statementDate,
    input.statementBalanceMinor,
    now.slice(0, 10),
  );
  const row = db
    .insert(reconciliations)
    .values({
      accountId: input.accountId,
      statementDate: input.statementDate,
      statementBalanceMinor: input.statementBalanceMinor,
      appBalanceMinor: check.ledgerMinor,
      status: check.differenceMinor === 0 ? "matched" : "unresolved",
      note: input.note ?? null,
      createdAt: now,
    })
    .returning()
    .get();
  return toRecord(row);
}

/** An account's saved checks, newest statement first. */
export function listReconciliations(db: AppDb, accountId: number): ReconciliationRecord[] {
  if (!listAccounts(db, undefined, true).some((a) => a.id === accountId)) {
    throw notFound("That account");
  }
  return db
    .select()
    .from(reconciliations)
    .where(eq(reconciliations.accountId, accountId))
    .orderBy(desc(reconciliations.statementDate), desc(reconciliations.id))
    .all()
    .map(toRecord);
}

export function updateReconciliationNote(
  db: AppDb,
  id: number,
  note: string | null,
): ReconciliationRecord {
  const row = db
    .update(reconciliations)
    .set({ note })
    .where(eq(reconciliations.id, id))
    .returning()
    .get();
  if (!row) throw notFound("That statement check");
  return toRecord(row);
}

export function deleteReconciliation(db: AppDb, id: number): void {
  const gone = db
    .delete(reconciliations)
    .where(eq(reconciliations.id, id))
    .returning({ id: reconciliations.id })
    .all();
  if (gone.length === 0) throw notFound("That statement check");
}
