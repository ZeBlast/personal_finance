import { Link } from "react-router-dom";
import { useApi } from "../../hooks/useApi";
import { timeAgo } from "../../lib/time";
import type { Diagnostics } from "../../types/data";

export type StatusTone = "good" | "warn" | "bad";

export interface StatusItem {
  label: string;
  value: string;
  detail: string;
  tone: StatusTone;
  /** Where to go to act on it. */
  action: { label: string; to: string } | null;
}

const DAY = 86_400_000;

/**
 * The app's health at a glance, for Settings: when the banks last synced, how old the newest
 * backup is, and whether the database checked out. Each says what to do when it needs attention.
 * Pure, for testing.
 */
export function statusItems(d: Diagnostics, now: number = Date.now()): StatusItem[] {
  const items: StatusItem[] = [];

  // Banks: the least recently synced connection, and any that need attention.
  const broken = d.connections.filter((c) => c.status !== "active" || c.lastErrorCode !== null);
  const syncs = d.connections
    .map((c) => c.lastSuccessfulSyncAt)
    .filter((s): s is string => s !== null)
    .sort();
  const oldest = syncs[0];
  if (d.connections.length === 0) {
    items.push({
      label: "Bank sync",
      value: "No banks connected",
      detail: "Connect one to bring in transactions automatically.",
      tone: "warn",
      action: { label: "Connect a bank", to: "/accounts" },
    });
  } else {
    const stale = oldest === undefined || now - Date.parse(oldest) > 3 * DAY;
    items.push({
      label: "Bank sync",
      value: oldest ? `Oldest ${timeAgo(oldest, now)}` : "Never synced",
      detail:
        broken.length > 0
          ? `${broken.length} connection${broken.length === 1 ? " needs" : "s need"} attention: ${broken
              .map((c) => c.institutionName)
              .join(", ")}.`
          : `${d.connections.length} connection${d.connections.length === 1 ? "" : "s"} working.`,
      tone: broken.length > 0 ? "bad" : stale ? "warn" : "good",
      action: broken.length > 0 || stale ? { label: "Open accounts", to: "/accounts" } : null,
    });
  }

  // Backups: the newest one's age.
  const newest = d.backups.newest;
  const backupAge = newest ? now - Date.parse(newest.createdAt) : Infinity;
  items.push({
    label: "Backups",
    value: newest ? `Newest ${timeAgo(newest.createdAt, now)}` : "None yet",
    detail:
      d.backups.pendingRestore !== null
        ? "A restore is waiting: it is applied when the app next starts."
        : `${d.backups.count} kept.`,
    tone: !newest ? "bad" : backupAge > 7 * DAY ? "warn" : "good",
    action:
      !newest || backupAge > 7 * DAY ? { label: "Make a backup", to: "/settings/data" } : null,
  });

  // The database itself.
  const healthy =
    d.integrity.result.length === 1 &&
    d.integrity.result[0] === "ok" &&
    d.integrity.brokenReferences === 0;
  items.push({
    label: "Data",
    value: healthy ? "Checked, no problems" : "Needs a look",
    detail: `${(d.counts["transactions"] ?? 0).toLocaleString()} transactions${
      d.recentProblems.length > 0
        ? ` · ${d.recentProblems.length} recent sync problem${d.recentProblems.length === 1 ? "" : "s"}`
        : ""
    }.`,
    tone: !healthy ? "bad" : d.recentProblems.length > 0 ? "warn" : "good",
    action:
      !healthy || d.recentProblems.length > 0
        ? { label: "Open diagnostics", to: "/settings/data" }
        : null,
  });
  return items;
}

const TONE: Record<StatusTone, string> = {
  good: "border-green-200 dark:border-green-900",
  warn: "border-amber-300 dark:border-amber-800",
  bad: "border-red-300 dark:border-red-800",
};
const DOT: Record<StatusTone, string> = {
  good: "bg-green-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
};

/** The status cards at the top of Settings. */
export function StatusOverview() {
  const diagnostics = useApi<Diagnostics>("/diagnostics");
  if (!diagnostics.data) return null;
  return (
    <section aria-label="Status" className="grid gap-3 sm:grid-cols-3">
      {statusItems(diagnostics.data).map((item) => (
        <div key={item.label} className={`rounded-lg border p-3 text-sm ${TONE[item.tone]}`}>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT[item.tone]}`} />
            {item.label}
          </div>
          <div className="mt-1 font-semibold">{item.value}</div>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{item.detail}</p>
          {item.action && (
            <Link to={item.action.to} className="mt-1 inline-block text-xs text-blue-600 underline">
              {item.action.label}
            </Link>
          )}
        </div>
      ))}
    </section>
  );
}
