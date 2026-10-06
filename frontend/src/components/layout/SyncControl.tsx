import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { announceSyncFinished } from "../../lib/syncEvents";
import { timeAgo } from "../../lib/time";
import type { SyncResult, SyncStatus } from "../../types/api";

type Message = { kind: "info" | "warning" | "error"; text: string };

/** Turns the outcome of a sync into one plain sentence for the user. */
function describe(result: SyncResult): Message {
  const { runs } = result;
  if (runs.length === 0) {
    return { kind: "info", text: "Nothing to sync yet. Connect an account first." };
  }
  const problems = runs.filter((r) => r.status !== "success");
  const offline = problems.find((r) => r.status === "offline");
  if (offline) {
    return {
      kind: "warning",
      text: "You appear to be offline, so nothing was updated. Your last synced data is shown.",
    };
  }
  const failed = problems.find((r) => r.status === "error" || r.status === "pending");
  if (failed) {
    return {
      kind: failed.status === "pending" ? "warning" : "error",
      text: `${failed.institutionName}: ${failed.errorMessage ?? "Sync failed."}`,
    };
  }
  const added = runs.reduce((sum, r) => sum + r.added, 0);
  const modified = runs.reduce((sum, r) => sum + r.modified, 0);
  const removed = runs.reduce((sum, r) => sum + r.removed, 0);
  if (added + modified + removed === 0) return { kind: "info", text: "Already up to date." };
  return {
    kind: "info",
    text: `Synced: ${added} new, ${modified} updated, ${removed} removed.`,
  };
}

const MESSAGE_STYLE: Record<Message["kind"], string> = {
  info: "text-slate-600 dark:text-slate-300",
  warning: "text-amber-700 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

export function SyncControl() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const wasSyncing = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const latest = await api<SyncStatus>("/sync/status");
      setStatus(latest);
      // A sync that started elsewhere (the launch sync, the timer) just finished: tell the pages.
      if (wasSyncing.current && !latest.syncing) announceSyncFinished();
      wasSyncing.current = latest.syncing;
    } catch {
      // The backend is checked and reported elsewhere (the banner at the top).
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), 3000);
    const clock = window.setInterval(() => setTick((n) => n + 1), 30_000); // refresh "x minutes ago"
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [refresh]);

  async function syncNow(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<SyncResult>("/sync", { method: "POST", body: JSON.stringify({}) });
      setMessage(describe(result));
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error, "The sync could not be started.") });
    } finally {
      setBusy(false);
      await refresh();
      announceSyncFinished();
    }
  }

  const syncing = busy || (status?.syncing ?? false);
  const synced = status?.items
    .map((i) => i.lastSuccessfulSyncAt)
    .filter((t): t is string => t !== null);
  // The oldest sync among connections is the honest "how fresh is my data" answer.
  const oldest = synced && synced.length > 0 ? synced.sort()[0] : undefined;

  let label = "Loading...";
  if (status) {
    if (status.items.length === 0) label = "No accounts connected";
    else if (syncing) label = "Syncing...";
    else if (oldest && synced?.length === status.items.length)
      label = `Last synced ${timeAgo(oldest)}`;
    else label = "Not synced yet";
  }

  return (
    <div className="mt-auto border-t border-slate-200 px-3 pt-3 text-xs dark:border-slate-700">
      <div aria-live="polite" className="text-slate-600 dark:text-slate-300">
        {label}
      </div>
      <button
        type="button"
        onClick={() => void syncNow()}
        disabled={syncing || status === null}
        className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-200 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700"
      >
        {syncing ? "Syncing..." : "Sync now"}
      </button>
      {message && (
        <p role="status" className={`mt-2 ${MESSAGE_STYLE[message.kind]}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
