import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { AppArea } from "../../app/routes";
import { NavBadge, useBadges } from "./NavBadge";

/**
 * The sections of an area (Transactions: Activity, Review, Categories & rules), as one row of tabs
 * above the page. Each section has its own address, so Back, Forward and links work. When the tabs
 * do not fit, the row scrolls sideways instead of wrapping, and the open tab is kept in view.
 */
export function SectionTabs({ area }: { area: AppArea }) {
  const badges = useBadges();
  const { pathname } = useLocation();
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  if (area.sections.length < 2) return null;
  return (
    <nav
      ref={nav}
      aria-label={`${area.label} sections`}
      // The bottom padding holds the tabs' 1px overlap so the row does not scroll up and down.
      className="mb-4 flex gap-1 overflow-x-auto border-b pb-px border-slate-200 dark:border-slate-700"
    >
      {area.sections.map((s) => (
        <NavLink
          key={s.path}
          to={s.path}
          // The first section shares the area's address: only an exact match marks it.
          end
          className={({ isActive }) =>
            `-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              isActive
                ? "border-blue-600 font-medium text-blue-700 dark:text-blue-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`
          }
        >
          {s.label}
          <NavBadge badge={badges[s.path] ?? null} />
        </NavLink>
      ))}
    </nav>
  );
}
