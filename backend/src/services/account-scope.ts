import { sql, type SQL } from "drizzle-orm";

/** The subtype of store credit (gift card) accounts. */
export const STORE_CREDIT_SUBTYPE = "store credit";

/**
 * Whether an account's money counts toward anything beyond the account itself: income, spending,
 * budgets, net worth, taxes, forecasts, reports. Hidden accounts do not, and neither do store credit
 * accounts, whose credits are not real dollars (they only count in the account's own balance and
 * history).
 */
export function countsInTotals(a: { hidden: boolean; subtype: string | null }): boolean {
  return !a.hidden && a.subtype !== STORE_CREDIT_SUBTYPE;
}

/** The same rule in SQL, for an `accounts` table under the given alias (a fixed name, never user input). */
export function countedAccount(alias: "a" | "acc" | "accounts" = "a"): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.hidden = 0 and coalesce(${a}.subtype, '') <> ${STORE_CREDIT_SUBTYPE})`;
}

/**
 * Accounts a query covers: one account asked for by id is covered whatever it is (its own
 * statistics), as long as it is not hidden; otherwise only accounts that count toward totals.
 */
export function accountScope(accountId: number | undefined, alias: "a" | "acc" = "a"): SQL {
  return accountId === undefined ? countedAccount(alias) : sql`${sql.raw(alias)}.hidden = 0`;
}

/**
 * Whether an account's balance is part of net worth. Store credit is: its credits are worth their
 * dollars to you, even though spending them is not real spending. Hidden accounts are not.
 */
export function countsInNetWorth(a: { hidden: boolean }): boolean {
  return !a.hidden;
}
