import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** What the button says: every category, the one picked, or how many. Pure. */
export function pickedLabel(picked: ReadonlySet<string>): string {
  if (picked.size === 0) return "All categories";
  if (picked.size === 1) return [...picked][0]!;
  return `${picked.size} categories`;
}

/**
 * Narrows the map to any number of categories: a button that opens a list of them with a tick box
 * each. None ticked means every category. Esc or a press outside closes the list.
 */
export function CategoryPicker({
  categories,
  picked,
  onChange,
}: {
  /** The categories on offer, with how many purchases each has on the map. */
  categories: Array<{ name: string; count: number }>;
  picked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPress = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPress);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPress);
    };
  }, [open]);

  const toggle = (name: string): void => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Categories on the map: ${pickedLabel(picked)}`}
        onClick={() => setOpen((o) => !o)}
        className={`flex max-w-56 items-center gap-1 rounded-md border bg-white px-2 py-1 text-sm dark:bg-slate-900 ${
          picked.size > 0
            ? "border-blue-600 text-blue-800 dark:border-blue-400 dark:text-blue-200"
            : "border-slate-300 dark:border-slate-600"
        }`}
      >
        <span className="truncate">{pickedLabel(picked)}</span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-600 dark:bg-slate-800">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-1.5 text-xs dark:border-slate-600">
            <span className="text-slate-500 dark:text-slate-400">Show on the map</span>
            <button
              type="button"
              disabled={picked.size === 0}
              onClick={() => onChange(new Set())}
              className="text-blue-700 underline disabled:text-slate-400 disabled:no-underline dark:text-blue-300"
            >
              All categories
            </button>
          </div>
          {categories.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
              No purchases have a place on the map yet.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {categories.map((c) => (
                <li key={c.name}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-slate-50 dark:hover:bg-slate-700/60">
                    <input
                      type="checkbox"
                      checked={picked.has(c.name)}
                      onChange={() => toggle(c.name)}
                    />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                      {c.count}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
