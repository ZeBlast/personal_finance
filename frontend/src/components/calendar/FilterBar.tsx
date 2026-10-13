import { isFiltered, ALL_SHOWN, type CalendarFilters } from "./filters";

const KINDS = [
  ["recorded", "Recorded", "Posted transactions"],
  ["pending", "Pending", "Pending transactions, and pending manual entries projected ahead"],
  ["planned", "Planned", "Planned transactions still expected"],
  [
    "forecast",
    "Forecast",
    "Projected cash in your bank accounts, card bills and recurring items found in your history",
  ],
] as const;

/**
 * Which kinds of items the calendar shows, and (in the agenda) a search. Hiding something only
 * changes what is shown: balances and the month overview still count everything.
 */
export function FilterBar({
  filters,
  onChange,
  searchable,
  lowCash,
  onLowCash,
}: {
  filters: CalendarFilters;
  onChange: (f: CalendarFilters) => void;
  /** Days whose projected cash falls below this (in cents) are marked. */
  lowCash: number;
  onLowCash: (minor: number) => void;
  /** The agenda can search its rows; the month grid cannot. */
  searchable: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Show in the calendar"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="text-xs text-slate-500 dark:text-slate-400">Show:</span>
      {KINDS.map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          aria-pressed={filters[key]}
          title={title}
          onClick={() => onChange({ ...filters, [key]: !filters[key] })}
          className={`rounded-full border px-3 py-0.5 text-xs ${
            filters[key]
              ? "border-slate-700 bg-slate-800 text-white dark:border-slate-300 dark:bg-slate-200 dark:text-slate-900"
              : "border-slate-300 text-slate-500 line-through dark:border-slate-600 dark:text-slate-400"
          }`}
        >
          {label}
        </button>
      ))}
      {filters.forecast && (
        <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          Warn when cash falls below $
          <input
            type="number"
            min={0}
            step={50}
            value={lowCash / 100}
            onChange={(e) => onLowCash(Math.max(0, Math.round(Number(e.target.value) * 100) || 0))}
            aria-label="Low cash warning level, in dollars"
            className="w-20 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-900"
          />
        </label>
      )}
      {searchable && (
        <input
          type="search"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder="Search merchant, category or account"
          aria-label="Search the agenda"
          className="min-w-48 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-900"
        />
      )}
      {isFiltered(filters) && (
        <>
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Some items are hidden; balances still count them.
          </span>
          <button
            type="button"
            onClick={() => onChange(ALL_SHOWN)}
            className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            Reset
          </button>
        </>
      )}
    </div>
  );
}
