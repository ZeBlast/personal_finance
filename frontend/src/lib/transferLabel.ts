import { accountLabel } from "./accountLabel";
import type { Transaction } from "../types/api";

const isDebt = (type: string): boolean => type === "credit" || type === "loan";

/**
 * Words for the other side of a matched transfer: which account paid a card ("Paid from Checking
 * (Chase)"), which card a payment went to ("Paid Visa (Chase)"), or where money moved.
 */
export function transferLabel(
  t: Pick<Transaction, "transferWith" | "accountType" | "amountMinor">,
): string | null {
  const other = t.transferWith;
  if (!other) return null;
  const name = accountLabel(other.accountName, other.institutionName);
  if (isDebt(t.accountType) && t.amountMinor < 0) return `Paid from ${name}`;
  if (isDebt(other.accountType) && t.amountMinor > 0) return `Paid ${name}`;
  return t.amountMinor > 0 ? `Moved to ${name}` : `Moved from ${name}`;
}
