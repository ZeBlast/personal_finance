/**
 * What the calendar shows. These only hide things from view: balances, totals and the month
 * overview always count everything in the chosen account scope.
 */
export interface CalendarFilters {
  /** Posted transactions. */
  recorded: boolean;
  /** Pending transactions, and pending manual entries projected ahead. */
  pending: boolean;
  /** Occurrences of planned transactions. */
  planned: boolean;
  /** Merchant, category or account text (the agenda). */
  search: string;
}

export const ALL_SHOWN: CalendarFilters = {
  recorded: true,
  pending: true,
  planned: true,
  search: "",
};

export function isFiltered(f: CalendarFilters): boolean {
  return !f.recorded || !f.pending || !f.planned || f.search.trim() !== "";
}

/** Whether an expected item of this source is shown. */
export const showsSource = (f: CalendarFilters, source: "planned" | "pending"): boolean =>
  source === "planned" ? f.planned : f.pending;

/** Whether a transaction is shown: pending ones under Pending, the rest under Recorded. */
export const showsTransaction = (f: CalendarFilters, pending: boolean): boolean =>
  pending ? f.pending : f.recorded;

/** Whether any of the texts contains the search (ignoring case); an empty search matches all. */
export function matchesSearch(
  f: CalendarFilters,
  ...texts: Array<string | null | undefined>
): boolean {
  const q = f.search.trim().toLowerCase();
  return q === "" || texts.some((t) => t?.toLowerCase().includes(q));
}
