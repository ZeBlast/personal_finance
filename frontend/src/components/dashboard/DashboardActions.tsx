import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MoreHorizontal } from "lucide-react";
import { Select } from "../common/Select";
import { applyPreset, presetNamed, PRESETS } from "../../widgets/presets";
import { api, errorMessage } from "../../api/client";
import type { DashboardList } from "../../types/analytics";
import { ConfirmDialog, Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";

type Dialog = "new" | "rename" | "delete" | null;

/** The "Start from" choice meaning a copy of the dashboard on show. */
const COPY = "copy";

const itemClass =
  "block w-full px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:hover:bg-slate-700 dark:focus:bg-slate-700";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState("");
  const [start, setStart] = useState(COPY);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const active = list.dashboards.find((d) => d.id === list.active);

  // While open, the first item has focus and a click anywhere else closes the menu.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => {
      if (!menuRef.current?.parentElement?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menuOpen]);

  function closeMenu(): void {
    setMenuOpen(false);
    buttonRef.current?.focus();
  }

  function menuKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  }

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
    setMenuOpen(false);
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
      <button
        ref={buttonRef}
        type="button"
        aria-label="Dashboard actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={`${buttonClass} px-2`}
        onClick={() => setMenuOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Dashboard actions"
          onKeyDown={menuKey}
          className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-slate-300 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
        >
          <button type="button" role="menuitem" className={itemClass} onClick={() => open("new")}>
            New dashboard
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => open("rename")}
          >
            Rename
          </button>
          {list.dashboards.length > 1 && (
            <button
              type="button"
              role="menuitem"
              className={`${itemClass} text-red-600 dark:text-red-400`}
              onClick={() => {
                setMenuOpen(false);
                setDialog("delete");
              }}
            >
              Delete
            </button>
          )}
        </div>
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
