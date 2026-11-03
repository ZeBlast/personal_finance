import { useId, useState, type FormEvent } from "react";
import { ActionMenu } from "../common/ActionMenu";
import { Select } from "../common/Select";
import { applyPreset, presetNamed, PRESETS } from "../../widgets/presets";
import { api, errorMessage } from "../../api/client";
import type { DashboardList } from "../../types/analytics";
import { ConfirmDialog, Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";

type Dialog = "new" | "rename" | "delete" | null;

/** The "Start from" choice meaning a copy of the dashboard on show. */
const COPY = "copy";

/**
 * A "..." menu with New dashboard, Rename and Delete (Delete only when there is more than one
 * dashboard). The menu opens with the keyboard too: Down or Enter opens it, the arrow keys move
 * through it, and Escape closes it.
 */
export function DashboardActions({
  list,
  onChanged,
  onError,
}: {
  list: DashboardList;
  /** Called after any change, to reload the list; `list` then shows the new active dashboard. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const id = useId();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState("");
  const [start, setStart] = useState(COPY);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = list.dashboards.find((d) => d.id === list.active);

  async function run(work: () => Promise<unknown>, failure: string): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      onChanged();
      return true;
    } catch (e) {
      const message = errorMessage(e, failure);
      if (dialog === "new" || dialog === "rename") setProblem(message);
      else onError(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function open(next: Dialog): void {
    setName(next === "rename" ? (active?.name ?? "") : "");
    setStart(COPY);
    setProblem(null);
    setDialog(next);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim() === "") {
      setProblem("Give the dashboard a name.");
      return;
    }
    const ok =
      dialog === "new"
        ? await run(async () => {
            const created = await api<{ id: number }>("/dashboards", {
              method: "POST",
              body: JSON.stringify({
                name,
                ...(start === COPY && active ? { copyFrom: active.id } : {}),
              }),
            });
            const preset = presetNamed(start);
            if (preset) await applyPreset(created.id, preset);
            await api(`/dashboards/${created.id}/activate`, { method: "POST", body: "{}" });
          }, "Could not create the dashboard.")
        : await run(
            () =>
              api(`/dashboards/${list.active}`, {
                method: "PATCH",
                body: JSON.stringify({ name }),
              }),
            "Could not rename the dashboard.",
          );
    if (ok) setDialog(null);
  }

  return (
    <div className="relative">
      <ActionMenu
        label="Dashboard actions"
        items={[
          { label: "New dashboard", onSelect: () => open("new") },
          { label: "Rename", onSelect: () => open("rename") },
          ...(list.dashboards.length > 1
            ? [{ label: "Delete", danger: true, onSelect: () => setDialog("delete") }]
            : []),
        ]}
      />

      {(dialog === "new" || dialog === "rename") && (
        <Modal
          title={dialog === "new" ? "New dashboard" : `Rename ${active?.name ?? "dashboard"}`}
          onClose={() => setDialog(null)}
        >
          <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
            <div>
              <label htmlFor={`${id}-name`} className="block font-medium">
                Name
              </label>
              <input
                id={`${id}-name`}
                value={name}
                autoFocus
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                placeholder="Investing"
                className={inputClass}
              />
            </div>
            {dialog === "new" && (
              <div>
                <label htmlFor={`${id}-start`} className="block font-medium">
                  Start from
                </label>
                <Select
                  id={`${id}-start`}
                  value={start}
                  onChange={(e) => {
                    setStart(e.target.value);
                    // A ready-made dashboard's name is a good start, unless one has been typed.
                    if (name === "" && presetNamed(e.target.value)) setName(e.target.value);
                  }}
                  className={inputClass}
                >
                  <option value={COPY}>A copy of {active?.name ?? "this dashboard"}</option>
                  {PRESETS.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                {presetNamed(start) && (
                  <p className="mt-1 text-xs text-slate-500">{presetNamed(start)!.blurb}</p>
                )}
              </div>
            )}
            {problem && (
              <p role="alert" className="text-red-600">
                {problem}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonClass} onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className={primaryClass} disabled={busy}>
                {busy ? "Saving..." : dialog === "new" ? "Create" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "delete" && active && (
        <ConfirmDialog
          title={`Delete ${active.name}?`}
          message={`The dashboard and its ${active.widgetCount} widget${
            active.widgetCount === 1 ? "" : "s"
          } will be removed. Your data is not affected.`}
          confirmLabel="Delete dashboard"
          danger
          busy={busy}
          onConfirm={() =>
            void run(
              () => api(`/dashboards/${active.id}`, { method: "DELETE" }),
              "Could not delete the dashboard.",
            ).then(() => setDialog(null))
          }
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
