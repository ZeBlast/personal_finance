import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../../api/client";
import { routes } from "../../app/routes";
import { useApi } from "../../hooks/useApi";
import type { Settings } from "../../types/api";
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

export function Sidebar() {
  const [searching, setSearching] = useState(false);
  const settings = useApi<Settings>("/settings");
  const [order, setOrder] = useState<string[] | null>(null);
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

  const shown = useMemo(
    () => orderRoutes(routes, order ?? settings.data?.navOrder ?? []),
    [order, settings.data],
  );

  function save(next: typeof shown): void {
    const paths = next.map((r) => r.path);
    setOrder(paths);
    void api("/settings", { method: "PATCH", body: JSON.stringify({ navOrder: paths }) }).catch(
      () => undefined, // the new order still shows; it is saved next time
    );
  }

  function drop(e: DragEvent, index: number): void {
    e.preventDefault();
    // Which page is moving travels with the drag (the state may not have caught up yet).
    const path = e.dataTransfer.getData("text/plain");
    const from = path ? shown.findIndex((r) => r.path === path) : (dragging ?? -1);
    if (from >= 0) save(moveItem(shown, from, index));
    setDragging(null);
    setOver(null);
  }

  // Alt+Up / Alt+Down move the focused page, for the keyboard.
  function onKey(e: KeyboardEvent, index: number): void {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const to = e.key === "ArrowUp" ? index - 1 : index + 1;
    if (to < 0 || to >= shown.length) return;
    save(moveItem(shown, index, to));
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`nav[aria-label="Main"] [data-nav="${shown[index]!.path}"]`)
        ?.focus(),
    );
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
      {shown.map(({ path, label }, index) => (
        <NavLink
          key={path}
          to={path}
          end={path === "/"}
          data-nav={path}
          draggable
          title="Drag to reorder (or Alt+Up / Alt+Down)"
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
          onKeyDown={(e) => onKey(e, index)}
          className={({ isActive }) =>
            `rounded-md px-3 py-2 text-sm font-medium ${
              isActive
                ? "bg-blue-600 text-white"
                : "text-slate-700 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-700"
            } ${dragging === index ? "opacity-40" : ""} ${
              over === index && dragging !== null && dragging !== index
                ? dragging < index
                  ? "shadow-[inset_0_-2px_0_0_#3b82f6]"
                  : "shadow-[inset_0_2px_0_0_#3b82f6]"
                : ""
            }`
          }
        >
          {label}
        </NavLink>
      ))}
      <SyncControl />
      {searching && <SearchPalette onClose={() => setSearching(false)} />}
    </nav>
  );
}
