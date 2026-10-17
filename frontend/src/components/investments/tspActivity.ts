import { api } from "../../api/client";
import { formatDay } from "../../lib/time";

/** What importing an Investment Activity Detail file did. */
export interface TspActivityResult {
  added: number;
  alreadyThere: number;
  skipped: number;
  from: string | null;
  to: string | null;
  holdingsUpdated: boolean;
}

/** The result as one sentence or a few, for the notice after importing. Pure. */
export function describeTspActivity(r: TspActivityResult): string {
  const range = r.from && r.to ? ` from ${formatDay(r.from)} to ${formatDay(r.to)}` : "";
  return [
    `Recorded ${r.added} contribution${r.added === 1 ? "" : "s"}${range}.`,
    r.alreadyThere > 0 ? `${r.alreadyThere} were already there.` : "",
    r.skipped > 0 ? `${r.skipped} for unknown funds were skipped.` : "",
    r.holdingsUpdated ? "The units were added to the holdings." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Imports the TSP's Investment Activity Detail file (from tsp.gov) into a TSP account: each
 * contribution with its fund, units and price, as the account's activity. With `updateHoldings`,
 * the units are also added to what the account holds. Importing the same file twice is safe.
 * Returns the summary to show.
 */
export async function importTspActivity(
  accountId: number,
  file: File,
  updateHoldings: boolean,
): Promise<string> {
  const csv = await file.text();
  const r = await api<TspActivityResult>(`/accounts/${accountId}/tsp/activity/import`, {
    method: "POST",
    body: JSON.stringify({ csv, updateHoldings }),
  });
  return describeTspActivity(r);
}
