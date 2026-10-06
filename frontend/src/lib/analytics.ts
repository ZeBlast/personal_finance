import type { SummaryGroup } from "../types/analytics";

export interface SummaryParams {
  from: string;
  to: string;
  groupBy?: SummaryGroup;
  /** An account ID as text, or "" for all accounts (the form a widget setting stores). */
  accountId?: string;
  /** A category ID as text, "none", or "" for all. */
  category?: string;
  rollupToParent?: boolean;
  includeTransfers?: boolean;
  includePending?: boolean;
  limit?: number;
  fill?: boolean;
}

/**
 * The URL of an `/analytics/summary` request, leaving out anything unset. Most widgets are a view of
 * this one query, so a new chart usually needs no new endpoint.
 */
export function summaryPath(params: SummaryParams): string {
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.groupBy) query.set("groupBy", params.groupBy);
  if (params.accountId) query.set("accountId", params.accountId);
  if (params.category) query.set("category", params.category);
  if (params.rollupToParent) query.set("rollupToParent", "1");
  if (params.includeTransfers) query.set("includeTransfers", "1");
  if (params.includePending === false) query.set("includePending", "0");
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.fill) query.set("fill", "1");
  return `/analytics/summary?${query}`;
}
