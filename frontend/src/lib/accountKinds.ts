import type { Account } from "../types/api";
import { formatMinor } from "./money";

/**
 * What each kind of account's balance means, in one place for the account list and the cards.
 * Plaid reports a card's or loan's balance as what is owed (positive), a bank account's as what
 * is in it, and an investment account's as what it is worth.
 */
type Shape = Pick<
  Account,
  "type" | "currency" | "currentBalanceMinor" | "availableBalanceMinor" | "creditLimitMinor"
>;

export const isDebtAccount = (a: Pick<Account, "type">): boolean =>
  a.type === "credit" || a.type === "loan";

/** A card paid past zero: the card owes the user money. */
export const hasCreditBalance = (a: Shape): boolean =>
  a.type === "credit" && (a.currentBalanceMinor ?? 0) < 0;

/** How much more a card can be charged: its limit less what is owed (not below zero). */
export function availableCreditMinor(a: Shape): number | null {
  if (a.type !== "credit" || !a.creditLimitMinor) return null;
  return Math.max(0, a.creditLimitMinor - Math.max(0, a.currentBalanceMinor ?? 0));
}

/** The balance to show: a credit balance is shown as a positive amount the card owes back. */
export function shownBalanceMinor(a: Shape): number | null {
  return hasCreditBalance(a) ? -(a.currentBalanceMinor ?? 0) : a.currentBalanceMinor;
}

/**
 * The day a connected account's balance was last updated, when it is no longer being kept up to
 * date (its bank needs a sign-in or has a problem, or Plaid no longer shares it); null when it is
 * current or kept by hand.
 */
export function frozenSince(
  a: Pick<Account, "isManual" | "connectionStatus" | "noLongerSharedAt" | "lastBalanceUpdateAt">,
): string | null {
  if (a.isManual) return null;
  if (a.noLongerSharedAt === null && a.connectionStatus === "active") return null;
  return (a.lastBalanceUpdateAt ?? a.noLongerSharedAt)?.slice(0, 10) ?? null;
}

/** The short word under or beside a balance: "Balance owed", "Credit balance", "Value"... */
export function balanceLabel(a: Shape): string {
  if (hasCreditBalance(a)) return "Credit balance";
  if (isDebtAccount(a)) return "Balance owed";
  if (a.type === "investment") return "Value";
  return "Balance";
}

/** The line of detail under a balance in the account list. */
export function balanceDetail(a: Shape): string {
  const money = (minor: number) => formatMinor(minor, a.currency);
  if (a.type === "credit") {
    if (hasCreditBalance(a)) return "credit balance · the card owes you this";
    if (!a.creditLimitMinor) return "balance owed";
    const used = Math.round((Math.max(0, a.currentBalanceMinor ?? 0) / a.creditLimitMinor) * 100);
    return `balance owed · ${used}% of ${money(a.creditLimitMinor)} used`;
  }
  if (a.type === "loan") return "balance owed";
  if (a.type === "investment") return "market value";
  return a.availableBalanceMinor !== null
    ? `${money(a.availableBalanceMinor)} available`
    : "current balance";
}
