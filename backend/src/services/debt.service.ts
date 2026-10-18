import { eq } from "drizzle-orm";
import { debtTerms } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Debt payoff: the cards and loans with what they owe, their interest rate and minimum payment,
 * and a month-by-month plan of paying them off with something extra each month.
 *
 * The plan pays every minimum, then puts the extra on one debt at a time: the highest rate first
 * (avalanche, the least interest) or the smallest balance first (snowball, the quickest wins). A
 * paid-off debt's minimum joins the extra, so the monthly total stays the same throughout.
 */

export type Strategy = "avalanche" | "snowball";

export interface DebtInput {
  id: number;
  name: string;
  balanceMinor: number;
  aprBps: number;
  minimumMinor: number;
}

export interface DebtAccount {
  id: number;
  name: string;
  type: string;
  balanceMinor: number;
  /** Null until the user enters the rate. */
  aprBps: number | null;
  /** The minimum used: entered, or estimated. */
  minimumMinor: number;
  minimumEstimated: boolean;
}

export interface PayoffPlan {
  /** Months until the last debt is paid, or null when the payments never catch up. */
  months: number | null;
  totalInterestMinor: number;
  monthlyPaymentMinor: number;
  /** In the order they are paid off. */
  debts: Array<{ id: number; name: string; payoffMonth: number | null; interestMinor: number }>;
  /** What is owed in all at the end of each month, for a chart (month 0 is now). */
  balances: number[];
}

export interface DebtOverview {
  debts: DebtAccount[];
  /** Debts left out of the plan because their rate is not entered yet. */
  missingRate: string[];
  strategy: Strategy;
  extraMinor: number;
  plan: PayoffPlan;
  /** The same debts with only the minimums. */
  minimumsOnly: PayoffPlan;
}

/** The most months a plan looks ahead: 50 years. */
const MAX_MONTHS = 600;

/** A card's minimum when none is entered: a month's interest plus 1% of the balance, at least $25. */
export function estimateMinimum(balanceMinor: number, aprBps: number): number {
  const interest = Math.round((balanceMinor * aprBps) / 10_000 / 12);
  return Math.min(balanceMinor, Math.max(2500, interest + Math.round(balanceMinor / 100)));
}

/** Pays the debts off month by month. Pure. */
export function simulatePayoff(
  input: DebtInput[],
  extraMinor: number,
  strategy: Strategy,
): PayoffPlan {
  const debts = input
    .filter((d) => d.balanceMinor > 0)
    .map((d) => ({ ...d, left: d.balanceMinor, interest: 0, payoffMonth: null as number | null }));
  const budget = debts.reduce((n, d) => n + d.minimumMinor, 0) + Math.max(0, extraMinor);
  const order = [...debts].sort((a, b) =>
    strategy === "avalanche"
      ? b.aprBps - a.aprBps || a.left - b.left
      : a.left - b.left || b.aprBps - a.aprBps,
  );
  const balances = [debts.reduce((n, d) => n + d.left, 0)];
  let month = 0;
  while (debts.some((d) => d.left > 0) && month < MAX_MONTHS) {
    month += 1;
    for (const d of debts) {
      if (d.left <= 0) continue;
      const interest = Math.round((d.left * d.aprBps) / 10_000 / 12);
      d.left += interest;
      d.interest += interest;
    }
    let money = budget;
    for (const d of debts) {
      const pay = Math.min(d.minimumMinor, d.left, money);
      d.left -= pay;
      money -= pay;
    }
    for (const d of order) {
      if (money <= 0) break;
      const pay = Math.min(d.left, money);
      d.left -= pay;
      money -= pay;
    }
    for (const d of debts) if (d.left <= 0 && d.payoffMonth === null) d.payoffMonth = month;
    balances.push(debts.reduce((n, d) => n + Math.max(0, d.left), 0));
  }
  const done = debts.every((d) => d.left <= 0);
  return {
    months: done ? month : null,
    totalInterestMinor: debts.reduce((n, d) => n + d.interest, 0),
    monthlyPaymentMinor: budget,
    debts: [...debts]
      .sort((a, b) => (a.payoffMonth ?? Infinity) - (b.payoffMonth ?? Infinity))
      .map((d) => ({
        id: d.id,
        name: d.name,
        payoffMonth: d.payoffMonth,
        interestMinor: d.interest,
      })),
    balances,
  };
}

/** The cards and loans that owe something now, with their terms. */
export function listDebts(db: AppDb): DebtAccount[] {
  const settings = getSettings(db);
  const terms = new Map(
    db
      .select()
      .from(debtTerms)
      .all()
      .map((t) => [t.accountId, t]),
  );
  return listAccounts(db)
    .filter(
      (a) =>
        a.countsInTotals &&
        (a.type === "credit" || a.type === "loan") &&
        a.currency === settings.currency &&
        (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment) &&
        (a.currentBalanceMinor ?? 0) > 0,
    )
    .map((a) => {
      const t = terms.get(a.id);
      const balance = a.currentBalanceMinor ?? 0;
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        balanceMinor: balance,
        aprBps: t?.aprBps ?? null,
        minimumMinor: t?.minimumMinor ?? estimateMinimum(balance, t?.aprBps ?? 0),
        minimumEstimated: t?.minimumMinor == null,
      };
    });
}

export function debtOverview(
  db: AppDb,
  options: { extraMinor?: number | undefined; strategy?: Strategy | undefined } = {},
): DebtOverview {
  const debts = listDebts(db);
  const strategy = options.strategy ?? "avalanche";
  const extraMinor = Math.max(0, options.extraMinor ?? 0);
  const planned: DebtInput[] = debts
    .filter((d) => d.aprBps !== null)
    .map((d) => ({
      id: d.id,
      name: d.name,
      balanceMinor: d.balanceMinor,
      aprBps: d.aprBps!,
      minimumMinor: d.minimumMinor,
    }));
  return {
    debts,
    missingRate: debts.filter((d) => d.aprBps === null).map((d) => d.name),
    strategy,
    extraMinor,
    plan: simulatePayoff(planned, extraMinor, strategy),
    minimumsOnly: simulatePayoff(planned, 0, strategy),
  };
}

export function setDebtTerms(
  db: AppDb,
  accountId: number,
  input: { aprBps: number; minimumMinor?: number | null | undefined },
  now = new Date().toISOString(),
): void {
  const account = listAccounts(db, undefined, true).find((a) => a.id === accountId);
  if (!account) throw notFound("That account");
  if (account.type !== "credit" && account.type !== "loan") {
    throw new AppError(400, "not_debt", "Only cards and loans have an interest rate here.");
  }
  const values = { aprBps: input.aprBps, minimumMinor: input.minimumMinor ?? null, updatedAt: now };
  db.insert(debtTerms)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: debtTerms.accountId, set: values })
    .run();
}

export function clearDebtTerms(db: AppDb, accountId: number): void {
  db.delete(debtTerms).where(eq(debtTerms.accountId, accountId)).run();
}
