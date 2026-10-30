import { useState } from "react";
import { usePersistentState } from "../../hooks/usePersistentState";
import { toast } from "../../lib/toast";

/** A named set of Activity's filters and sort, such as "Uncategorized on cards this month". */
export interface SavedView<F> {
  name: string;
  filters: F;
  sort: string;
}

/** Saves a view, replacing one of the same name (ignoring case); the newest goes last. */
export function withView<F>(views: readonly SavedView<F>[], view: SavedView<F>): SavedView<F>[] {
  const key = view.name.trim().toLowerCase();
  return [...views.filter((v) => v.name.trim().toLowerCase() !== key), view];
}

/**
 * Saved views on Activity: each is a button that brings its filters and sort back; × forgets it
 * (with Undo). "Save this view" names the filters in use. Kept in this browser, like the other
 * page preferences.
 */
export function SavedViews<F>({
  current,
  sort,
  canSave,
  onApply,
}: {
  current: F;
  sort: string;
  /** Whether anything is filtered (an unfiltered view is just the page). */
  canSave: boolean;
  onApply: (view: SavedView<F>) => void;
}) {
  const [views, setViews] = usePersistentState<SavedView<F>[]>("pf.activity.views", []);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  if (views.length === 0 && !canSave) return null;

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setViews(withView(views, { name: trimmed, filters: current, sort }));
    setNaming(false);
    setName("");
    toast(`Saved the view "${trimmed}".`);
  };

  const chip =
    "rounded-full border border-slate-300 px-3 py-1 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800";

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Saved views">
      {views.length > 0 && <span className="text-xs text-slate-500">Views:</span>}
      {views.map((v) => (
        <span key={v.name} className="inline-flex items-center">
          <button
            type="button"
            className={`${chip} rounded-r-none border-r-0`}
            onClick={() => onApply(v)}
          >
            {v.name}
          </button>
          <button
            type="button"
            aria-label={`Forget the view ${v.name}`}
            title="Forget this view"
            className={`${chip} rounded-l-none px-2 text-slate-400`}
            onClick={() => {
              const before = views;
              setViews(views.filter((x) => x !== v));
              toast(`Forgot the view "${v.name}".`, {
                action: { label: "Undo", run: () => setViews(before) },
              });
            }}
          >
            ×
          </button>
        </span>
      ))}
      {canSave &&
        (naming ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNaming(false);
              }}
              maxLength={40}
              placeholder="Name this view"
              aria-label="Name for this view"
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800"
            />
            <button type="submit" className={chip} disabled={!name.trim()}>
              Save
            </button>
            <button
              type="button"
              className="text-xs text-slate-500 underline"
              onClick={() => setNaming(false)}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className={`${chip} text-blue-700 dark:text-blue-300`}
            onClick={() => setNaming(true)}
          >
            + Save this view
          </button>
        ))}
    </div>
  );
}
