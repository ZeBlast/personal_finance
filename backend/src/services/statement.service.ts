import { eq, sql } from "drizzle-orm";
import { accounts } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, addMonths, lastOfMonth } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";

/**
 * Statement periods of a credit card. The user sets the day of the month the statement closes
 * (and, optionally, the day payment is due); each period then runs from the day after one closing
 * date through the next. Activity is placed by posted date, as the card's statement does, and
 * pending charges wait for the period they post in.
 */

export interface StatementSettings {
  closingDay: number | null;
  dueDay: number | null;
}

/** The closing date in a month (`YYYY-MM`): that day, or the month's last day if shorter. */
export function closingDateIn(month: string, closingDay: number): string {
  const last = lastOfMonth(month);
  const day = Math.min(closingDay, Number(last.slice(8)));
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** The first date with day `dueDay` (or the month's last day) after `closing`. */
export function dueDateAfter(closing: string, dueDay: number): string {
  for (let k = 0; k < 2; k++) {
    const candidate = closingDateIn(addMonths(closing.slice(0, 7), k), dueDay);
    if (candidate > closing) return candidate;
  }
  return closingDateIn(addMonths(closing.slice(0, 7), 2), dueDay);
}

export interface Period {
  start: string;
  end: string;
  due: string | null;
  /** The period `today` is in: still open. */
  current: boolean;
}

/** The `count` most recent statement periods, newest first, the open one included. */
export function statementPeriods(
  closingDay: number,
  dueDay: number | null,
  today: string,
  count: number,
): Period[] {
  // The closing date that ends the open period: this month's, or next month's once it has passed.
  let end = closingDateIn(today.slice(0, 7), closingDay);
  if (end < today) end = closingDateIn(addMonths(today.slice(0, 7), 1), closingDay);
  const periods: Period[] = [];
  for (let i = 0; i < count; i++) {
    const previous = closingDateIn(addMonths(end.slice(0, 7), -1), closingDay);
    periods.push({
      start: addDays(previous, 1),
      end,
      due: dueDay === null ? null : dueDateAfter(end, dueDay),
      current: i === 0,
    });
    end = previous;
  }
  return periods;
}

export interface StatementSummary extends Period {
  /** Purchases, fees and interest: money charged to the card (cents). */
  chargesMinor: number;
  /** Payments toward the card (cents, positive). */
  paymentsMinor: number;
  /** Refunds, cashback and other credits (cents, positive). */
  creditsMinor: number;
  /** How much the balance rose (positive) or fell over the period. */
  netMinor: number;
  /**
   * What was owed when the period closed: the statement's "new balance" (for the open period, the
   * balance so far). Worked out from the card's current balance less what posted since, so it is
   * null when the bank gives no balance.
   */
  newBalanceMinor: number | null;
  /** What was owed when the period before it closed: the statement's "previous balance". */
  previousBalanceMinor: number | null;
  count: number;
  /** Spending by category: charges less the refunds in the same category. */
  categories: Array<{
    id: number | null;
    name: string;
    color: string | null;
    spendingMinor: number;
  }>;
  merchants: Array<{ name: string; spendingMinor: number; count: number }>;
}

export interface Statements {
  accountId: number;
  closingDay: number | null;
  dueDay: number | null;
  periods: StatementSummary[];
}

function requireCard(db: Pick<AppDb, "select">, accountId: number) {
  const account = db
    .select({
      id: accounts.id,
      type: accounts.type,
      currentBalanceMinor: accounts.currentBalanceMinor,
      closingDay: accounts.statementClosingDay,
      dueDay: accounts.statementDueDay,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) throw notFound("That account");
  if (account.type !== "credit") {
    throw new AppError(409, "not_a_card", "Statement periods are for credit cards.");
  }
  return account;
}

const checkDay = (day: number | null, what: string): void => {
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) {
    throw new AppError(400, "invalid_day", `The ${what} day is a day of the month, 1 to 31.`);
  }
};

/** Sets (or, with null, clears) a card's statement closing and due days. */
export function setStatementSettings(
  db: AppDb,
  accountId: number,
  settings: StatementSettings,
  now = new Date().toISOString(),
): StatementSettings {
  requireCard(db, accountId);
  checkDay(settings.closingDay, "closing");
  checkDay(settings.dueDay, "due");
  const dueDay = settings.closingDay === null ? null : settings.dueDay;
  db.update(accounts)
    .set({ statementClosingDay: settings.closingDay, statementDueDay: dueDay, updatedAt: now })
    .where(eq(accounts.id, accountId))
    .run();
  return { closingDay: settings.closingDay, dueDay };
}

const MERCHANT = sql`coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name)`;

/** The card's statement periods with what happened in each (none until a closing day is set). */
export function statements(
  db: AppDb,
  accountId: number,
  count = 12,
  today = new Date().toISOString().slice(0, 10),
): Statements {
  const card = requireCard(db, accountId);
  const base = { accountId, closingDay: card.closingDay, dueDay: card.dueDay };
  if (card.closingDay === null) return { ...base, periods: [] };
  const periods = statementPeriods(card.closingDay, card.dueDay, today, count);
  const from = periods[periods.length - 1]!.start;
  const to = periods[0]!.end;

  // A payment toward the card: money in that is matched with the money that paid it, or that the
  // bank files as a loan payment. Other money in is a credit (a refund, cashback).
  const isPayment = sql`(t.amount_minor < 0 and (t.is_transfer = 1
    or coalesce(t.plaid_category_primary, '') = 'LOAN_PAYMENTS'))`;
  const rows = db.all<{
    date: string;
    amount: number;
    payment: number;
    category_id: number | null;
    category: string | null;
    color: string | null;
    merchant: string;
  }>(sql`
    select t.date as date, t.amount_minor as amount, ${isPayment} as payment,
      c.id as category_id, c.name as category, c.color as color, ${MERCHANT} as merchant
    from transactions t left join categories c on c.id = t.category_id
    where t.account_id = ${accountId} and t.pending = 0 and t.date between ${from} and ${to}`);

  // The balance owed at the end of a day: today's balance less everything posted after that day.
  // Posted only, as the bank's balance (and the statement) leave pending charges out.
  const later = db.all<{ date: string; amount: number }>(sql`
    select date, amount_minor as amount from transactions
    where account_id = ${accountId} and pending = 0 and date >= ${periods[periods.length - 1]!.start}`);
  const balanceAt = (day: string): number | null =>
    card.currentBalanceMinor === null
      ? null
      : card.currentBalanceMinor -
        later.filter((r) => r.date > day).reduce((n, r) => n + r.amount, 0);

  return {
    ...base,
    periods: periods.map((p) => {
      const inside = rows.filter((r) => r.date >= p.start && r.date <= p.end);
      let chargesMinor = 0;
      let paymentsMinor = 0;
      let creditsMinor = 0;
      const byCategory = new Map<string, StatementSummary["categories"][number]>();
      const byMerchant = new Map<string, StatementSummary["merchants"][number]>();
      for (const r of inside) {
        if (r.amount > 0) chargesMinor += r.amount;
        else if (r.payment) paymentsMinor -= r.amount;
        else creditsMinor -= r.amount;
        if (r.payment) continue;
        const key = String(r.category_id ?? "none");
        const cat = byCategory.get(key) ?? {
          id: r.category_id,
          name: r.category ?? "Uncategorized",
          color: r.color,
          spendingMinor: 0,
        };
        cat.spendingMinor += r.amount;
        byCategory.set(key, cat);
        if (r.amount > 0) {
          const m = byMerchant.get(r.merchant) ?? { name: r.merchant, spendingMinor: 0, count: 0 };
          m.spendingMinor += r.amount;
          m.count += 1;
          byMerchant.set(r.merchant, m);
        }
      }
      return {
        ...p,
        chargesMinor,
        paymentsMinor,
        creditsMinor,
        netMinor: chargesMinor - paymentsMinor - creditsMinor,
        newBalanceMinor: balanceAt(p.current ? today : p.end),
        previousBalanceMinor: balanceAt(addDays(p.start, -1)),
        count: inside.length,
        categories: [...byCategory.values()]
          .filter((c) => c.spendingMinor !== 0)
          .sort((a, b) => b.spendingMinor - a.spendingMinor),
        merchants: [...byMerchant.values()]
          .sort((a, b) => b.spendingMinor - a.spendingMinor)
          .slice(0, 8),
      };
    }),
  };
}
