import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { DashboardLayout, SavedWidget } from "../types/analytics";
import { buildDefaultLayout } from "../widgets/layout";
import { allWidgets } from "../widgets/registry";
import type { PlacedWidget } from "../widgets/types";

const toPlaced = (saved: SavedWidget): PlacedWidget => ({ ...saved, key: String(saved.id) });

/** What the server stores: everything except the UI-only key. */
const toSaved = (w: PlacedWidget): Omit<PlacedWidget, "key"> => ({
  ...(w.id === undefined ? {} : { id: w.id }),
  widgetType: w.widgetType,
  enabled: w.enabled,
  x: w.x,
  y: w.y,
  w: w.w,
  h: w.h,
  config: w.config,
});

/**
 * Loads the dashboard layout and edits it as a draft: nothing is saved until Done, and Cancel throws
 * the draft away. The very first time (nothing saved yet), the default layout is built from the
 * widget registry and saved.
 */
export function useDashboard(dashboardId: number) {
  const query = `?dashboardId=${dashboardId}`;
  const [saved, setSaved] = useState<PlacedWidget[] | null>(null);
  const [draft, setDraft] = useState<PlacedWidget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const put = useCallback(
    async (widgets: PlacedWidget[]): Promise<PlacedWidget[]> => {
      const result = await api<DashboardLayout>(`/dashboard/widgets${query}`, {
        method: "PUT",
        body: JSON.stringify({ widgets: widgets.map(toSaved) }),
      });
      return result.widgets.map(toPlaced);
    },
    [query],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const layout = await api<DashboardLayout>(`/dashboard/widgets${query}`);
        if (cancelled) return;
        if (layout.initialized) {
          setSaved(layout.widgets.map(toPlaced));
          return;
        }
        const defaults = buildDefaultLayout(allWidgets());
        try {
          const stored = await put(defaults);
          if (!cancelled) setSaved(stored);
        } catch (e) {
          // Show the defaults even if they could not be saved; they are saved on the next Done.
          if (!cancelled) {
            setSaved(defaults);
            setError(errorMessage(e, "The default dashboard could not be saved."));
          }
        }
      } catch (e) {
        if (!cancelled) {
          setSaved([]);
          setError(errorMessage(e, "Could not load the dashboard."));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [put, query]);

  const startEditing = useCallback(() => {
    setDraft((current) => current ?? (saved ? saved.map((w) => ({ ...w })) : null));
    setError(null);
  }, [saved]);

  const cancelEditing = useCallback(() => {
    setDraft(null);
    setError(null);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setSaving(true);
    setError(null);
    try {
      setSaved(await put(draft));
      setDraft(null);
      return true;
    } catch (e) {
      setError(errorMessage(e, "Could not save the dashboard."));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, put]);

  /** Replaces the dashboard with the default layout and saves it. */
  const resetToDefault = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api<DashboardLayout>(`/dashboard/reset${query}`, { method: "POST", body: "{}" });
      setSaved(await put(buildDefaultLayout(allWidgets())));
      setDraft(null);
    } catch (e) {
      setError(errorMessage(e, "Could not reset the dashboard."));
    } finally {
      setSaving(false);
    }
  }, [put, query]);

  /** Change the draft (only while editing). */
  const update = useCallback((change: (widgets: PlacedWidget[]) => PlacedWidget[]) => {
    setDraft((current) => (current ? change(current) : current));
  }, []);

  return {
    widgets: draft ?? saved,
    editing: draft !== null,
    startEditing,
    cancelEditing,
    save,
    resetToDefault,
    update,
    saving,
    error,
    clearError: () => setError(null),
  };
}
