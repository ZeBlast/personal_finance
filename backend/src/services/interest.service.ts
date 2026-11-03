import { eq, sql } from "drizzle-orm";
import { accountYields } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";

/**
 * What bank accounts earn in interest: the APY the user enters for an account (checking, savings,
 * money market), an estimate of what that pays at today's balance, and the interest the account
 * actually received, from its history.
 *
 * APY already includes compounding, so a month's rate is (1 + APY)^(1/12) - 1, not APY / 12.
 */

/** The most an APY can be here, in hundredths of a percent (50%). */
export const MAX_APY_BPS = 5_000;

/** A month's interest rate from a yearly APY in hundredths of a percent. Pure. */
export function monthlyRate(apyBps: number): number {
  return Math.pow(1 + apyBps / 10_000, 1 / 12) - 1;
}

/**
 * The interest paid each month for `months` months on a balance at an APY, each month's interest
 * earning interest after it, in whole cents. Nothing for a balance of zero or less. Pure.
 */
export function monthlyInterest(balanceMinor: number, apyBps: number, months: number): number[] {
  const rate = monthlyRate(apyBps);
  const paid: number[] = [];
  let balance = Math.max(0, balanceMinor);
  for (let k = 0; k < months; k += 1) {
    const interest = Math.round(balance * rate);
    paid.push(interest);
    balance += interest;
  }
  return paid;
}

/** The APY of each bank account that has one, by account ID. */
export function accountYieldsById(db: AppDb): Map<number, number> {
  return new Map(
    db
      .select()
      .from(accountYields)
      .all()
      .map((y) => [y.accountId, y.apyBps]),
  );
}

export interface AccountInterest {
  accountId: number;
  /** Null until the user enters one. */
  apyBps: number | null;
  balanceMinor: number | null;
  /** At today's balance: next month's interest, and the next 12 months' together. */
  monthlyMinor: number | null;
  yearlyMinor: number | null;
  /** Interest the account received this calendar year, and in the last 12 months. */
  earnedThisYearMinor: number;
  earnedLast12MonthsMinor: number;
}

function requireBankAccount(db: AppDb, accountId: number) {
  const account = listAccounts(db, undefined, true).find((a) => a.id === accountId);
  if (!account) throw notFound("That account");
  if (account.type !== "depository") {
    throw new AppError(400, "not_a_bank_account", "Only bank accounts earn interest here.");
  }
  return account;
}

/** Interest received into an account since a day: money in, marked as interest by the bank or the user. */
function interestSince(db: AppDb, accountId: number, from: string, to: string): number {
  const row = db.get<{ total: number | null }>(sql`
    select -sum(t.amount_minor) as total
    from transactions t left join categories c on c.id = t.category_id
    where t.account_id = ${accountId} and t.pending = 0 and t.amount_minor < 0
      and t.date >= ${from} and t.date <= ${to}
      and (t.plaid_category_detailed = 'INCOME_INTEREST_EARNED'
        or c.name = 'Interest & Dividends'
        or lower(coalesce(t.merchant_name_user, t.merchant_name, t.name)) like '%interest%')`);
  return row?.total ?? 0;
}

export function accountInterest(
  db: AppDb,
  accountId: number,
  today: string = new Date().toISOString().slice(0, 10),
): AccountInterest {
  const account = requireBankAccount(db, accountId);
  const apyBps = accountYieldsById(db).get(accountId) ?? null;
  const balance = account.currentBalanceMinor;
  const year = apyBps === null || balance === null ? null : monthlyInterest(balance, apyBps, 12);
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  return {
    accountId,
    apyBps,
    balanceMinor: balance,
    monthlyMinor: year ? year[0]! : null,
    yearlyMinor: year ? year.reduce((n, x) => n + x, 0) : null,
    earnedThisYearMinor: interestSince(db, accountId, `${today.slice(0, 4)}-01-01`, today),
    earnedLast12MonthsMinor: interestSince(db, accountId, yearAgo, today),
  };
}

export function setAccountYield(
  db: AppDb,
  accountId: number,
  apyBps: number,
  now: string = new Date().toISOString(),
): void {
  requireBankAccount(db, accountId);
  if (!Number.isInteger(apyBps) || apyBps < 0 || apyBps > MAX_APY_BPS) {
    throw new AppError(400, "invalid_apy", "Enter an APY from 0% to 50%.");
  }
  db.insert(accountYields)
    .values({ accountId, apyBps, updatedAt: now })
    .onConflictDoUpdate({ target: accountYields.accountId, set: { apyBps, updatedAt: now } })
    .run();
}

export function clearAccountYield(db: AppDb, accountId: number): void {
  db.delete(accountYields).where(eq(accountYields.accountId, accountId)).run();
}
