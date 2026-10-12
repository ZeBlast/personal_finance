import { eq, sql } from "drizzle-orm";
import { accounts, cardBills } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate, lastOfMonth } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { getSettings } from "./settings.service.js";
import { isCardPayment } from "./transfer.service.js";
import { pendingManualTransactions } from "./pending-manual.service.js";

/**
 * Credit card bills. The user says on which day of the month each card's statement closes and on
 * which day payment is due; the app works out the latest statement's balance from the card's current
 * balance and the transactions since the statement closed, and whether it has been paid since.
 *
 * It is an estimate: a bank's statement can differ by pending charges, interest, and fees posted at
 * the close. Payments are recognized the same way as everywhere else (not promotions or refunds).
 */

export interface BillSettings {
  closingDay: number;
  dueDay: number;
  minimumMinor: number | null;
  autopay: boolean;
}

export type BillStatus = "paid" | "partial" | "due" | "overdue" | "nothing_due";

export interface CardBill {
  accountId: number;
  name: string;
  institutionName: string | null;
  color: string | null;
  currency: string;
  /** What is owed on the card now (null when the bank gave no balance). */
  currentBalanceMinor: number | null;
  /** Null until the user sets the card's closing and due days. */
  settings: BillSettings | null;
  statement: {
    closedOn: string;
    dueOn: string;
    balanceMinor: number;
    paidMinor: number;
    remainingMinor: number;
    minimumMinor: number | null;
    status: BillStatus;
    /** Days until it is due (negative once overdue). */
    daysUntilDue: number;
  } | null;
  /** The statement after this one, as it stands so far. */
  next: { closesOn: string; dueOn: string; balanceSoFarMinor: number } | null;
}

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** A day of the month in a month, moved to the month's last day when the month is shorter. */
export function dayIn(month: string, day: number): string {
  const last = Number(lastOfMonth(month).slice(8));
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** The latest statement closing on or before `today`, and the one after it. */
export function closingDates(closingDay: number, today: string): { last: string; next: string } {
  const month = today.slice(0, 7);
  const thisMonth = dayIn(month, closingDay);
  const last = thisMonth <= today ? thisMonth : dayIn(shiftMonth(month, -1), closingDay);
  return { last, next: dayIn(shiftMonth(last.slice(0, 7), 1), closingDay) };
}

/** The first due day after a statement closes. */
export function dueAfter(closedOn: string, dueDay: number): string {
  const sameMonth = dayIn(closedOn.slice(0, 7), dueDay);
  return sameMonth > closedOn ? sameMonth : dayIn(shiftMonth(closedOn.slice(0, 7), 1), dueDay);
}

function requireCard(db: AppDb, accountId: number): void {
  const account = db
    .select({ type: accounts.type })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) throw notFound("That account");
  if (account.type !== "credit") {
    throw new AppError(409, "not_a_credit_card", "Bill dates belong to credit cards.");
  }
}

export function setBillSettings(
  db: AppDb,
  accountId: number,
  input: BillSettings,
  now: string = new Date().toISOString(),
): void {
  requireCard(db, accountId);
  for (const day of [input.closingDay, input.dueDay]) {
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new AppError(400, "invalid_day", "Days of the month are 1 to 31.");
    }
  }
  const values = { ...input, updatedAt: now };
  db.insert(cardBills)
    .values({ accountId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: cardBills.accountId, set: values })
    .run();
}

export function clearBillSettings(db: AppDb, accountId: number): void {
  db.delete(cardBills).where(eq(cardBills.accountId, accountId)).run();
}

/** Every credit card in use, with its latest statement when its dates are set. */
export function listBills(
  db: AppDb,
  today: string = new Date().toISOString().slice(0, 10),
): CardBill[] {
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const environment = getSettings(db).plaidEnvironment;
  const cards = listAccounts(db).filter(
    (a) => a.type === "credit" && (a.itemId === null || a.connectionEnvironment === environment),
  );
  const settings = new Map(
    db
      .select()
      .from(cardBills)
      .all()
      .map((b) => [b.accountId, b]),
  );

  return cards.map((card) => {
    const base: CardBill = {
      accountId: card.id,
      name: card.name,
      institutionName: card.institutionName,
      color: card.color,
      currency: card.currency,
      currentBalanceMinor: card.currentBalanceMinor,
      settings: null,
      statement: null,
      next: null,
    };
    const s = settings.get(card.id);
    if (!s) return base;
    base.settings = {
      closingDay: s.closingDay,
      dueDay: s.dueDay,
      minimumMinor: s.minimumMinor,
      autopay: s.autopay,
    };
    if (card.currentBalanceMinor === null) return base;

    const { last, next } = closingDates(s.closingDay, today);
    const after = db.all<{ amount: number; category: string | null; name: string }>(sql`
      select amount_minor as amount, plaid_category_primary as category,
        coalesce(plaid_category_detailed, '') || ' ' || name as name
      from transactions
      where account_id = ${card.id} and date > ${last} and pending = 0`);
    const sinceClose = after.reduce((n, t) => n + t.amount, 0);
    const balance = card.currentBalanceMinor - sinceClose;
    const paid = after
      .filter((t) => t.amount < 0 && isCardPayment(t))
      .reduce((n, t) => n - t.amount, 0);
    const dueOn = dueAfter(last, s.dueDay);
    const remaining = Math.max(0, balance - paid);
    const status: BillStatus =
      balance <= 0
        ? "nothing_due"
        : remaining === 0
          ? "paid"
          : today > dueOn
            ? "overdue"
            : paid > 0
              ? "partial"
              : "due";
    base.statement = {
      closedOn: last,
      dueOn,
      balanceMinor: balance,
      paidMinor: paid,
      remainingMinor: remaining,
      minimumMinor: s.minimumMinor,
      status,
      daysUntilDue: dayNumber(dueOn) - dayNumber(today),
    };
    base.next = {
      closesOn: next,
      dueOn: dueAfter(next, s.dueDay),
      // What has been charged this cycle, less anything paid beyond the last statement.
      balanceSoFarMinor: Math.max(
        0,
        card.currentBalanceMinor -
          remaining +
          pendingManualTransactions(db, {
            to: next,
            currency: card.currency,
            accountId: card.id,
          }).reduce((sum, t) => sum + t.amountMinor, 0),
      ),
    };
    return base;
  });
}
