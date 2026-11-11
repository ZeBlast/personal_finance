import type { Overview, BudgetMonth } from "../../../frontend/src/types/analytics";
import type { Account, Transaction, TransactionPage } from "../../../frontend/src/types/api";
import type { CalendarEvent } from "../../../frontend/src/types/calendar";
import type { Snapshot } from "./snapshot";

/**
 * Looks views up in a snapshot. Paths carry the dates they were asked for, so most are found by
 * how they start. Each returns null when the PC could not read that view.
 */
export function view<T>(snapshot: Snapshot, path: string): T | null {
  const resources = snapshot.body.resources;
  if (path in resources) return resources[path] as T;
  const key = Object.keys(resources).find((k) => k.startsWith(path));
  return key === undefined ? null : (resources[key] as T);
}

export const overview = (s: Snapshot) => view<Overview>(s, "/analytics/overview");
export const accounts = (s: Snapshot) => view<Account[]>(s, "/accounts") ?? [];
export const caps = (s: Snapshot) => view<BudgetMonth>(s, "/budgets?");
export const upcoming = (s: Snapshot) => view<CalendarEvent[]>(s, "/calendar/expected?") ?? [];
export const transactions = (s: Snapshot): Transaction[] =>
  view<TransactionPage>(s, "/transactions?")?.items ?? [];

export interface SyncItem {
  itemId: number;
  institutionName: string;
  connectionStatus: string;
  lastSuccessfulSyncAt: string | null;
}

export const syncItems = (s: Snapshot): SyncItem[] =>
  view<{ items: SyncItem[] }>(s, "/sync/status")?.items ?? [];

/** Account groups in the order a person looks for them. */
export const GROUPS: Array<{ type: string; label: string }> = [
  { type: "depository", label: "Cash" },
  { type: "credit", label: "Credit cards" },
  { type: "investment", label: "Investments" },
  { type: "loan", label: "Loans" },
];

export function groupAccounts(list: Account[]): Array<{ label: string; accounts: Account[] }> {
  const shown = list.filter((a) => !a.hidden);
  const known = new Set(GROUPS.map((g) => g.type));
  const groups = GROUPS.map((g) => ({
    label: g.label,
    accounts: shown.filter((a) => a.type === g.type),
  }));
  groups.push({ label: "Other", accounts: shown.filter((a) => !known.has(a.type)) });
  return groups.filter((g) => g.accounts.length > 0);
}

/** `YYYY-MM-DD` plus days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** How long ago, in words: "just now", "25 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Older than this, the snapshot is flagged as stale on the Home screen. */
export const STALE_HOURS = 48;

export const isStale = (iso: string, now: Date = new Date()): boolean =>
  now.getTime() - Date.parse(iso) > STALE_HOURS * 3_600_000;

/** "Mon, Nov 9" for a `YYYY-MM-DD` day (read as a calendar day, not shifted by time zone). */
export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
