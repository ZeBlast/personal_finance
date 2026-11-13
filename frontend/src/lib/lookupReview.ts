import type { GeocodeStatus, Lookup, Precision } from "../types/places";

/**
 * Checking the positions that address lookups found: which list a lookup belongs in, the order
 * they are shown in, and the wording. All pure.
 */

export type ReviewTab = "check" | "checked" | "nothing";

export const REVIEW_TABS: Array<{ id: ReviewTab; label: string }> = [
  { id: "check", label: "To check" },
  { id: "checked", label: "Checked" },
  { id: "nothing", label: "Found nothing" },
];

const PRECISION_LABEL: Record<Precision, string> = {
  address: "Address",
  street: "Street only",
  shop: "Shop",
  postcode: "Postal code",
  city: "City",
};
export const precisionLabel = (p: Precision): string => PRECISION_LABEL[p];

/** Only the street's, the postal code's or the city's position. */
export const isApproximate = (l: Lookup): boolean =>
  l.verdict !== "moved" &&
  (l.precision === "street" || l.precision === "postcode" || l.precision === "city");

/** The lookup server gave a position (as opposed to none, or only one set by hand). */
export const isAnswered = (l: Lookup): boolean =>
  l.found !== null || (l.lat !== null && l.verdict !== "moved");

/** Where a lookup is listed: one you have judged is checked; one with no position found nothing. */
export function tabOf(l: Lookup): ReviewTab {
  if (l.verdict !== null) return "checked";
  return l.lat === null ? "nothing" : "check";
}

/**
 * The lookups of one list. Those to check come with the approximate ones first, then the ones
 * that place the most purchases: the positions most worth a look.
 */
export function inTab(lookups: Lookup[], tab: ReviewTab): Lookup[] {
  const mine = lookups.filter((l) => tabOf(l) === tab);
  return mine.sort(
    (a, b) =>
      (tab === "check" ? Number(isApproximate(b)) - Number(isApproximate(a)) : 0) ||
      b.purchases - a.purchases ||
      a.asked.localeCompare(b.asked),
  );
}

export function tabCounts(lookups: Lookup[]): Record<ReviewTab, number> {
  const counts: Record<ReviewTab, number> = { check: 0, checked: 0, nothing: 0 };
  for (const l of lookups) counts[tabOf(l)] += 1;
  return counts;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const purchasesText = (l: Lookup): string => plural(l.purchases, "purchase", "purchases");

/** What the lookup server answered, in words. */
export function foundText(l: Lookup): string {
  if (l.found !== null) return `Found: ${l.found}`;
  return isAnswered(l) ? "Found a position without a name" : "Found nothing";
}

/** Your call on a lookup, in words; null when you have made none. */
export function verdictText(l: Lookup): string | null {
  if (l.verdict === "right") return "You said this is right";
  if (l.verdict === "wrong") return "You said this is wrong, so it is not used";
  if (l.verdict === "moved") return "You set this position yourself";
  return null;
}

/** The line in the lookups panel that leads to the review; null while there is nothing to review. */
export function reviewSummary(s: Pick<GeocodeStatus, "lookups" | "unchecked">): string | null {
  if (s.lookups === 0) return null;
  const found = plural(s.lookups, "looked-up position", "looked-up positions");
  return s.unchecked === 0 ? `${found}, all checked.` : `${found}, ${s.unchecked} not checked yet.`;
}
