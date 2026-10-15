import { NavLink } from "react-router-dom";
import type { AppArea } from "../../app/routes";

/**
 * The sections of an area (Transactions: Activity, Review, Categories & rules), as one row of tabs
 * above the page. Each section has its own address, so Back, Forward and links work.
 */
export function SectionTabs({ area }: { area: AppArea }) {
  if (area.sections.length < 2) return null;
  return (
    <nav
      aria-label={`${area.label} sections`}
      className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-700"
    >
      {area.sections.map((s) => (
        <NavLink
          key={s.path}
          to={s.path}
          // The first section shares the area's address: only an exact match marks it.
          end
          className={({ isActive }) =>
            `-mb-px border-b-2 px-3 py-2 text-sm ${
              isActive
                ? "border-blue-600 font-medium text-blue-700 dark:text-blue-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`
          }
        >
          {s.label}
        </NavLink>
      ))}
    </nav>
  );
}
