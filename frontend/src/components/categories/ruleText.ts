/** Rules: how a rule and what it would do are put into words. Pure. */
import { formatMinor } from "../../lib/money";
import type { RuleField, RuleOperator, RulePreview } from "../../types/api";

/**
 * What saving a rule would really do, in a sentence: "Saving changes 12 of the 30 it matches; 1
 * chosen by hand stays." Pure.
 */
export function ruleEffectText(p: RulePreview): string {
  const changes = p.changeCount ?? 0;
  const manual = p.manualCount ?? 0;
  const head =
    changes === 0
      ? `Saving changes nothing: the ${p.matchCount} it matches already have their category`
      : `Saving changes ${changes} transaction${changes === 1 ? "" : "s"}` +
        (p.matchCount !== changes ? ` (it matches ${p.matchCount})` : "");
  const tail = manual > 0 ? `; ${manual} chosen by hand stay${manual === 1 ? "s" : ""}` : "";
  return `${head}${tail}.`;
}

/** The change to spending in each category: "Dining +$15.00 (3) · Treats −$15.00 (3)". Pure. */
export function ruleTotalsText(
  totals: NonNullable<RulePreview["totals"]>,
  currency: string,
): string {
  return totals
    .map((t) => {
      const sign = t.changeMinor < 0 ? "−" : "+";
      return `${t.name ?? "Uncategorized"} ${sign}${formatMinor(Math.abs(t.changeMinor), currency)} (${t.count})`;
    })
    .join(" · ");
}

/** What undoing a batch did: what was put back, and what kept a category changed since. Pure. */
export function batchUndoText(r: { restored: number; kept: unknown[] }): string {
  const head = `Put back ${r.restored} transaction${r.restored === 1 ? "" : "s"}.`;
  if (r.kept.length === 0) return head;
  return `${head} ${r.kept.length} you changed since keep${r.kept.length === 1 ? "s" : ""} ${
    r.kept.length === 1 ? "its" : "their"
  } new category.`;
}

export const FIELD_LABEL: Record<RuleField, string> = {
  merchant: "Merchant",
  name: "Bank description",
  recipient: "Recipient",
  sender: "Sender",
  plaid_category: "Bank category",
};

export const OPERATOR_LABEL: Record<RuleOperator, string> = {
  equals: "is exactly",
  contains: "contains",
  starts_with: "starts with",
  same_merchant: "is the same merchant as",
};
