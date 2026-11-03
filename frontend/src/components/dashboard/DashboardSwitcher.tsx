import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import type { DashboardList } from "../../types/analytics";

/**
 * Tabs for the named dashboards, in the same style as the section tabs of Planning and
 * Transactions. Switching is disabled while a dashboard is being edited, so a half-finished edit is
 * never carried (or lost) by accident. New, Rename and Delete are in `DashboardActions`.
 */
export function DashboardSwitcher({
  list,
  disabled,
  onChanged,
  onError,
}: {
  list: DashboardList;
  /** True while editing: finish with Done or Cancel first. */
  disabled: boolean;
  /** Called after any change, to reload the list; `list` then shows the new active dashboard. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function switchTo(id: number): Promise<void> {
    setBusy(true);
    try {
      await api(`/dashboards/${id}/activate`, { method: "POST", body: "{}" });
      onChanged();
    } catch (e) {
      onError(errorMessage(e, "Could not switch dashboards."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Choose a dashboard"
      className="flex flex-wrap gap-1 border-b border-slate-200 @max-6xl:order-last @max-6xl:w-full dark:border-slate-700"
    >
      {list.dashboards.map((d) => (
        <button
          key={d.id}
          type="button"
          role="tab"
          aria-selected={d.id === list.active}
          disabled={disabled || busy}
          onClick={() => d.id !== list.active && void switchTo(d.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm disabled:opacity-60 ${
            d.id === list.active
              ? "border-blue-600 font-medium text-blue-700 dark:text-blue-300"
              : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
          }`}
        >
          {d.name}
        </button>
      ))}
    </div>
  );
}
