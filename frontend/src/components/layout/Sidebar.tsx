import { NavLink } from "react-router-dom";
import { routes } from "../../app/routes";
import { SyncControl } from "./SyncControl";

export function Sidebar() {
  return (
    <nav
      aria-label="Main"
      className="flex w-52 shrink-0 flex-col gap-1 border-r border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800"
    >
      <div className="px-3 py-2 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        Personal Finance
      </div>
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
    </nav>
  );
}
