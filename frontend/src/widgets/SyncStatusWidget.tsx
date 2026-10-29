import { useState } from "react";
import { api, errorMessage } from "../api/client";
import { useApi } from "../hooks/useApi";
import { announceSyncFinished } from "../lib/syncEvents";
import { timeAgo } from "../lib/time";
import type { SyncStatus } from "../types/api";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

const RUN_LABEL: Record<string, string> = {
  success: "Synced",
  offline: "Offline",
  pending: "Not ready yet",
  error: "Problem",
  running: "Syncing...",
};

export default defineWidget({
  id: "sync-status",
  title: "Sync status",
  description: "When each connection was last synced, with a Sync now button.",
  group: "Tools",
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  order: 110,
  singleton: true,
  Component: function SyncStatusCard() {
    const { data, error, loading, reload } = useApi<SyncStatus>("/sync/status");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    async function syncNow(): Promise<void> {
      setBusy(true);
      setProblem(null);
      try {
        await api("/sync", { method: "POST", body: "{}" });
      } catch (e) {
        setProblem(errorMessage(e, "The sync could not be started."));
      } finally {
        setBusy(false);
        reload();
        announceSyncFinished();
      }
    }

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.items.length === 0}
        emptyText="No accounts connected yet."
      >
        <div className="space-y-3">
          <ul className="space-y-2 text-sm">
            {data?.items.map((item) => (
              <li key={item.itemId} className="flex items-baseline justify-between gap-3">
                <span className="truncate">{item.institutionName}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {item.lastSuccessfulSyncAt
                    ? `synced ${timeAgo(item.lastSuccessfulSyncAt)}`
                    : "not synced yet"}
                  {item.lastRun && item.lastRun.status !== "success"
                    ? ` · ${RUN_LABEL[item.lastRun.status] ?? item.lastRun.status}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy || data?.syncing}
            onClick={() => void syncNow()}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700"
          >
            {busy || data?.syncing ? "Syncing..." : "Sync now"}
          </button>
          {problem && (
            <p role="alert" className="text-sm text-red-600">
              {problem}
            </p>
          )}
        </div>
      </WidgetState>
    );
  },
});
