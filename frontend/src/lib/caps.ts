import type { Budget, CapStatus } from "../types/analytics";
import { lastOfMonth } from "./period";

/** Which way round caps are listed: the ones that need attention first. */
const ORDER: Record<CapStatus, number> = { over: 0, risk: 1, full: 2, ok: 3 };

/** Caps that need attention first, then the fullest. Pure. */
export function sortCaps<T extends { status: CapStatus; percentUsed: number }>(caps: T[]): T[] {
  return [...caps].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.percentUsed - a.percentUsed,
  );
}

/** How many days of a month are left, counting today; null when it is not the current month. Pure. */
export function daysLeftIn(month: string, today: string): number | null {
  if (today.slice(0, 7) !== month) return null;
  return Number(lastOfMonth(month).slice(8, 10)) - Number(today.slice(8, 10)) + 1;
}

export const STATUS_WORD: Record<CapStatus, string> = {
  over: "Over",
  risk: "Heading over",
  full: "Reached",
  ok: "On track",
};

/** The line under a cap's meter, in words. Pure. */
export function capDetail(
  b: Pick<Budget, "status" | "remainingMinor" | "availableMinor" | "projectedMinor">,
  daysLeft: number | null,
  money: (minor: number) => string,
): string {
  if (b.status === "over") return `by ${money(-b.remainingMinor)}`;
  if (b.status === "full") return "Nothing left this month";
  if (b.status === "risk" && b.projectedMinor !== null) {
    return `Could end near ${money(b.projectedMinor)}, ${money(b.projectedMinor - b.availableMinor)} over`;
  }
  if (daysLeft !== null && daysLeft > 0) {
    const perDay = Math.floor(b.remainingMinor / daysLeft);
    return `${money(b.remainingMinor)} left, about ${money(perDay)} a day`;
  }
  return `${money(b.remainingMinor)} left`;
}

/** A cap's whole reading in a sentence, for screen readers and on hover. Pure. */
export function capReading(
  b: Pick<Budget, "status" | "remainingMinor" | "availableMinor" | "projectedMinor" | "spentMinor">,
  daysLeft: number | null,
  money: (minor: number) => string,
): string {
  return `${money(b.spentMinor)} of ${money(b.availableMinor)}. ${STATUS_WORD[b.status]}: ${capDetail(b, daysLeft, money)}.`;
}

/** An even pace for today across caps, not counting a subcategory whose parent has a cap too. Pure. */
export function totalExpected(
  caps: Array<Pick<Budget, "categoryId" | "parentId" | "expectedMinor">>,
): number {
  const capped = new Set(caps.map((c) => c.categoryId));
  return caps
    .filter((c) => c.parentId === null || !capped.has(c.parentId))
    .reduce((sum, c) => sum + (c.expectedMinor ?? 0), 0);
}

/** A starting point for a new cap: what a typical month costs, rounded up to the next $10. Pure. */
export function suggestedCap(c: { averageMinor: number; spentMinor: number }): number {
  const typical = c.averageMinor > 0 ? c.averageMinor : c.spentMinor;
  return Math.ceil(typical / 1000) * 1000;
}

/** How the months with a cap went, for a cap's small chart. Pure. */
export function historyWords(history: Budget["history"]): string {
  const capped = (history ?? []).filter((h) => h.capMinor !== null);
  if (capped.length === 0) return "No earlier months with a cap.";
  const within = capped.filter((h) => h.spentMinor <= h.capMinor!).length;
  return `Within the cap in ${within} of ${capped.length} month${capped.length === 1 ? "" : "s"}.`;
}

/**
 * How a month's caps went: how many held, and (only when some went over) a separate part naming
 * what went over, so the page can show just that part in red. Pure.
 */
export function reportVerdict(
  items: Array<{ label: string; status: CapStatus; remainingMinor: number }>,
  money: (minor: number) => string,
): { held: string; over: string | null } {
  const over = items.filter((i) => i.status === "over");
  if (over.length === 0) {
    return {
      held:
        items.length === 1 ? "Stayed within the cap." : `Stayed within all ${items.length} caps.`,
      over: null,
    };
  }
  const named = over
    .slice(0, 3)
    .map((i) => `${i.label} by ${money(-i.remainingMinor)}`)
    .join(", ");
  const others = over.length > 3 ? `, and ${over.length - 3} more` : "";
  return {
    held: `${items.length - over.length} of ${items.length} caps held.`,
    over: `Over: ${named}${others}.`,
  };
}
