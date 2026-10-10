import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { routes } from "../../app/routes";
import { SearchPalette } from "./SearchPalette";
import { SyncControl } from "./SyncControl";

export function Sidebar() {
  const [searching, setSearching] = useState(false);

  // Ctrl+K (or Cmd+K) opens the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <nav
      aria-label="Main"
      className="flex w-52 shrink-0 flex-col gap-1 border-r border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800"
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
      {routes.map(({ path, label }) => (
        <NavLink
          key={path}
          to={path}
          end={path === "/"}
          className={({ isActive }) =>
            `rounded-md px-3 py-2 text-sm font-medium ${
              isActive
                ? "bg-blue-600 text-white"
                : "text-slate-700 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-700"
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
