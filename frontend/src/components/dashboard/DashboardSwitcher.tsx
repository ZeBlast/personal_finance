import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import type { DashboardList } from "../../types/analytics";
import { ConfirmDialog, Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";

type Dialog = "new" | "rename" | "delete" | null;

/**
 * Tabs for the named dashboards, plus New, Rename and Delete. Switching is disabled while a
 * dashboard is being edited, so a half-finished edit is never carried (or lost) by accident.
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
  const id = useId();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState("");
  const [copy, setCopy] = useState(true);
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
    setCopy(true);
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
              body: JSON.stringify({ name, ...(copy && active ? { copyFrom: active.id } : {}) }),
            });
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
    <div className="flex flex-wrap items-center gap-2" aria-label="Dashboards">
      <div role="tablist" aria-label="Choose a dashboard" className="flex flex-wrap gap-1">
        {list.dashboards.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={d.id === list.active}
            disabled={disabled || busy}
            onClick={() =>
              d.id !== list.active &&
              void run(
                () => api(`/dashboards/${d.id}/activate`, { method: "POST", body: "{}" }),
                "Could not switch dashboards.",
              )
            }
            className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-60 ${
              d.id === list.active
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
            }`}
          >
            {d.name}
          </button>
        ))}
      </div>
      <button type="button" className={buttonClass} disabled={disabled} onClick={() => open("new")}>
        New dashboard
      </button>
      {!disabled && (
        <>
          <button type="button" className={buttonClass} onClick={() => open("rename")}>
            Rename
          </button>
          {list.dashboards.length > 1 && (
            <button type="button" className={buttonClass} onClick={() => setDialog("delete")}>
              Delete
            </button>
          )}
        </>
      )}

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
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
                Start from a copy of {active?.name ?? "this dashboard"}
              </label>
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
