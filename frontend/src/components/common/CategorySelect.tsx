import type { SelectHTMLAttributes } from "react";

/**
 * A category dropdown whose open list shows the hierarchy (main categories marked "■", their
 * subcategories indented with "└", see categoryOptions), while the closed box shows only the
 * chosen category's plain name. A plain dropdown shows the chosen option's text as it is, so the
 * box's own text (and with it the browser's arrow, drawn in the text colour) is hidden, and the
 * name and an arrow are laid over it instead.
 */
export function CategorySelect({
  shown,
  className = "",
  children,
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & {
  /** What the closed box says: the chosen category's name. */
  shown: string;
}) {
  return (
    <span className="relative block">
      <select
        {...select}
        className={`${className} appearance-none pr-7 text-transparent [&>option]:text-slate-900 dark:[&>option]:bg-slate-800 dark:[&>option]:text-slate-100`}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-7 left-2 flex items-center truncate"
      >
        {shown}
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 opacity-70"
      >
        <path
          d="M4 6l4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
