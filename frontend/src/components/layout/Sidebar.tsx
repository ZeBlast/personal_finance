import { useEffect, useMemo, useState, type DragEvent } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../../api/client";
import { areas, migrateNavOrder } from "../../app/routes";
import { useApi } from "../../hooks/useApi";
import type { Settings } from "../../types/api";
import { areaBadge, NavBadge, useBadges } from "./NavBadge";
import { SearchPalette } from "./SearchPalette";
import { SyncControl } from "./SyncControl";

/**
 * The pages in the user's order: the ones they placed first, in that order, then any others (new
 * pages, say) in their usual place.
 */
export function orderRoutes<T extends { path: string }>(all: T[], order: string[]): T[] {
  const byPath = new Map(all.map((r) => [r.path, r]));
  const placed = order.map((p) => byPath.get(p)).filter((r): r is T => r !== undefined);
  const seen = new Set(placed.map((r) => r.path));
  return [...placed, ...all.filter((r) => !seen.has(r.path))];
}

/** Moves the item at `from` to sit at `to` (an index in the list before the move). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item!);
  return next;
}

/** Pages that can never be hidden: the home page, and Settings (where hiding is undone). */
export const ALWAYS_SHOWN: ReadonlySet<string> = new Set(["/", "/settings"]);

/** The pages the sidebar shows: everything not hidden, never hiding Dashboard or Settings. */
export function visibleRoutes<T extends { path: string }>(ordered: T[], hidden: string[]): T[] {
  const off = new Set(hidden.filter((p) => !ALWAYS_SHOWN.has(p)));
  return ordered.filter((r) => !off.has(r.path));
}

const smallButton =
  "rounded px-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-slate-700 dark:hover:text-slate-100";

export function Sidebar() {
  const [searching, setSearching] = useState(false);
  const settings = useApi<Settings>("/settings");
  const badges = useBadges();
  const [order, setOrder] = useState<string[] | null>(null);
  const [hidden, setHidden] = useState<string[] | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  // Ctrl+K (or Cmd+K) opens the search from anywhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The areas in the user's order (an order saved before the areas carries over).
  const ordered = useMemo(
    () => orderRoutes(areas, migrateNavOrder(order ?? settings.data?.navOrder ?? [])),
    [order, settings.data],
  );
  const hiddenPaths = hidden ?? settings.data?.navHidden ?? [];
  const shown = visibleRoutes(ordered, hiddenPaths);

  function persist(patch: Partial<Pick<Settings, "navOrder" | "navHidden">>): void {
    void api("/settings", { method: "PATCH", body: JSON.stringify(patch) }).catch(
      () => undefined, // the change still shows; it is saved next time
    );
  }

  function saveOrder(next: typeof ordered): void {
    const paths = next.map((r) => r.path);
    setOrder(paths);
    persist({ navOrder: paths });
  }

  function toggle(path: string): void {
    const next = hiddenPaths.includes(path)
      ? hiddenPaths.filter((p) => p !== path)
      : [...hiddenPaths, path];
    setHidden(next);
    persist({ navHidden: next });
  }

  function reset(): void {
    setOrder([]);
    setHidden([]);
    persist({ navOrder: [], navHidden: [] });
  }

  function drop(e: DragEvent, index: number): void {
    e.preventDefault();
    // Which page is moving travels with the drag (the state may not have caught up yet).
    const path = e.dataTransfer.getData("text/plain");
    const from = path ? ordered.findIndex((r) => r.path === path) : (dragging ?? -1);
    if (from >= 0) saveOrder(moveItem(ordered, from, index));
    setDragging(null);
    setOver(null);
  }

  return (
    <nav
      aria-label="Main"
      className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800"
    >
      <div className="px-3 py-2 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        Personal Finance
      </div>
      <button
        type="button"
        onClick={() => setSearching(true)}
        className="mb-1 flex items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-400"
      >
        <span>Search...</span>
        <kbd className="rounded border border-slate-300 px-1 text-[10px] dark:border-slate-600">
          Ctrl K
        </kbd>
      </button>

      {customizing ? (
        <div className="rounded-lg border border-blue-200 bg-white p-2 dark:border-blue-900 dark:bg-slate-900">
          <p className="px-1 pb-2 text-xs text-slate-600 dark:text-slate-300">
            Drag <span aria-hidden="true">⠿</span> or use the arrows to reorder. Untick a page to
            hide it; hidden pages are still in Search.
          </p>
          <ul className="space-y-0.5">
            {ordered.map(({ path, label }, index) => {
              const locked = ALWAYS_SHOWN.has(path);
              const isHidden = !locked && hiddenPaths.includes(path);
              return (
                <li
                  key={path}
                  draggable
                  onDragStart={(e) => {
                    setDragging(index);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", path);
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes("text/plain")) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (over !== index) setOver(index);
                  }}
                  onDrop={(e) => drop(e, index)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  className={`flex items-center gap-1 rounded px-1 py-1 text-sm ${
                    dragging === index ? "opacity-40" : ""
                  } ${
                    over === index && dragging !== null && dragging !== index
                      ? dragging < index
                        ? "shadow-[inset_0_-2px_0_0_#3b82f6]"
                        : "shadow-[inset_0_2px_0_0_#3b82f6]"
                      : ""
                  }`}
                >
                  <span
                    aria-hidden="true"
                    title="Drag to move"
                    className="cursor-grab text-slate-400 select-none"
                  >
                    ⠿
                  </span>
                  <label
                    className={`flex min-w-0 flex-1 items-center gap-1.5 ${
                      isHidden ? "text-slate-400 line-through" : ""
                    }`}
                    title={locked ? "Always shown" : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      disabled={locked}
                      onChange={() => toggle(path)}
                      aria-label={`Show ${label} in the sidebar`}
                    />
                    <span className="truncate">{label}</span>
                  </label>
                  <button
                    type="button"
                    className={smallButton}
                    disabled={index === 0}
                    onClick={() => saveOrder(moveItem(ordered, index, index - 1))}
                    aria-label={`Move ${label} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={smallButton}
                    disabled={index === ordered.length - 1}
                    onClick={() => saveOrder(moveItem(ordered, index, index + 1))}
                    aria-label={`Move ${label} down`}
                  >
                    ↓
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex justify-between gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Reset to default
            </button>
            <button
              type="button"
              onClick={() => setCustomizing(false)}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          {shown.map(({ path, label }) => (
            <NavLink
              key={path}
              to={path}
              end={path === "/"}
              data-nav={path}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : "text-slate-700 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-700"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {label}
                  <NavBadge
                    badge={path === "/" ? null : areaBadge(badges, path)}
                    active={isActive}
                  />
                </>
              )}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setCustomizing(true)}
            className="mt-1 rounded-md px-3 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
          >
            <span aria-hidden="true">✎</span> Customize sidebar
          </button>
        </>
      )}
      <SyncControl />
      {searching && <SearchPalette onClose={() => setSearching(false)} />}
    </nav>
  );
}
