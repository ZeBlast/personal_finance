import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { signedMoney } from "../../lib/scenarios";
import { formatDay } from "../../lib/time";
import type { Scenario, ScenarioAdjustment } from "../../types/planning";
import { Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../common/styles";
import { WhatIfForm, type OneOffAdjustment } from "./WhatIfForm";

/** The what-ifs added from the chart and not saved yet, each removable, with the ways to keep or drop them. */
export function WhatIfChips({
  draft,
  currency,
  onRemove,
  onClear,
  onSave,
}: {
  draft: OneOffAdjustment[];
  currency: string;
  onRemove: (index: number) => void;
  onClear: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {draft.map((a, i) => {
        const text = `${signedMoney(a.amountMinor, currency)} · ${a.label} · ${formatDay(a.date)}`;
        return (
          <span
            key={`${a.date}-${i}`}
            className="inline-flex items-center gap-1 rounded-full bg-violet-100 py-0.5 pr-1 pl-3 text-violet-800 dark:bg-violet-950 dark:text-violet-200"
          >
            <span className="tabular-nums">{text}</span>
            <button
              type="button"
              aria-label={`Remove ${text}`}
              onClick={() => onRemove(i)}
              className="rounded-full px-1.5 hover:bg-violet-200 dark:hover:bg-violet-900"
            >
              ✕
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={onClear}
        className="text-xs text-slate-500 underline dark:text-slate-400"
      >
        Clear all
      </button>
      <button type="button" className={buttonClass} onClick={onSave}>
        Save as scenario...
      </button>
    </div>
  );
}

/** The what-if form as a dialog, with a day to pick: the way to add one without a mouse. */
export function AddWhatIfDialog({
  currency,
  dates,
  onAdd,
  onClose,
}: {
  currency: string;
  dates: { min: string; max: string };
  onAdd: (a: OneOffAdjustment) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Add a what-if" onClose={onClose}>
      <WhatIfForm
        currency={currency}
        dates={dates}
        onAdd={(a) => {
          onAdd(a);
          onClose();
        }}
        onCancel={onClose}
      />
    </Modal>
  );
}

/** Asks for a name and saves the adjustments as a new scenario. */
export function SaveWhatIfsDialog({
  adjustments,
  onSaved,
  onClose,
}: {
  adjustments: ScenarioAdjustment[];
  onSaved: (saved: Scenario) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (name.trim() === "") return setError("Give the scenario a name.");
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Scenario>("/forecast/scenarios", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), adjustments }),
      });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Save as scenario" onClose={onClose}>
      <form onSubmit={(e) => void save(e)} className="space-y-3 text-sm">
        <label className="block">
          Name
          <input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={primaryClass}>
            {busy ? "Saving..." : "Save scenario"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
