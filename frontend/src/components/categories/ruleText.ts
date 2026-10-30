/** Rules: how a rule and what it would do are put into words. Pure. */
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
