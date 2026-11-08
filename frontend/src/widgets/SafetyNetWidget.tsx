import { useState } from "react";
import { api, errorMessage } from "../api/client";
import { ProgressBar } from "../components/charts/ProgressBar";
import { Modal } from "../components/common/Modal";
import { useApi } from "../hooks/useApi";
import { today } from "../lib/period";
import { runwayText } from "../lib/planTools";
import { announceDataChanged } from "../lib/syncEvents";
import type { Category, Settings } from "../types/api";
import type { SafetyNet } from "../types/planTools";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/** Ticks the categories the safety net counts, and saves them as a setting. */
function EssentialsDialog({
  chosen,
  onClose,
  onSaved,
}: {
  chosen: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const categories = useApi<Category[]>("/categories");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(chosen));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const top = (categories.data ?? [])
    .filter((c) => c.active && c.parentId === null && c.incomeTreatment === null)
    .sort((a, b) => a.name.localeCompare(b.name));

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ essentialCategoryIds: [...picked] }),
      });
      announceDataChanged();
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <Modal title="Your essentials" onClose={onClose}>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Tick what you could not go without, such as rent, groceries, utilities and insurance. Each
        includes its subcategories.
      </p>
      <WidgetState loading={categories.loading} error={categories.error}>
        <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {top.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setPicked(next);
                  }}
                />
                {c.name}
              </label>
            </li>
          ))}
        </ul>
      </WidgetState>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

export default defineWidget({
  id: "safety-net",
  title: "Safety net",
  description: "How many months your cash would cover your essentials if pay stopped.",
  group: "Accounts",
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  defaultEnabled: false,
  order: 160,
  defaultConfig: { target: 6 },
  configFields: [
    { key: "target", label: "Months you aim for", type: "number", min: 1, max: 24, step: 1 },
  ],
  Component: function SafetyNetWidget({ config }) {
    const { data, error, loading, reload } = useApi<SafetyNet>(`/safety-net?today=${today()}`);
    const settings = useApi<Settings>("/settings");
    const [choosing, setChoosing] = useState(false);
    const target = Number(config.target);
    const text = data ? runwayText(data, target) : null;

    return (
      <WidgetState loading={loading} error={error}>
        {data && text && (
          <div className="flex h-full flex-col gap-2">
            <div>
              <div
                className={`text-2xl font-semibold tabular-nums ${
                  text.tone === "good" ? "text-green-700 dark:text-green-400" : ""
                }`}
              >
                {text.headline}
              </div>
              {data.months !== null && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  of the {target} you aim for
                </div>
              )}
            </div>
            {data.months !== null && (
              <ProgressBar
                value={Math.min(data.months, target)}
                max={target}
                label="Safety net, in months"
                color={text.tone === "good" ? "#16a34a" : "#d97706"}
              />
            )}
            <p className="text-sm text-slate-600 dark:text-slate-300">{text.detail}</p>
            <button
              type="button"
              onClick={() => setChoosing(true)}
              // Until the saved choices load, saving would start from none and clear them.
              disabled={!settings.data}
              className="mt-auto self-start text-sm font-medium text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              {data.basis === "essential" ? "Change essentials" : "Choose essentials"}
            </button>
            {choosing && (
              <EssentialsDialog
                chosen={settings.data?.essentialCategoryIds ?? []}
                onClose={() => setChoosing(false)}
                onSaved={() => {
                  setChoosing(false);
                  settings.reload();
                  reload();
                }}
              />
            )}
          </div>
        )}
      </WidgetState>
    );
  },
});
