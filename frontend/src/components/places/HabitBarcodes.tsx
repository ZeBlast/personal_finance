import { paceText, type Habit } from "../../lib/places";

/**
 * Habit barcodes: one strip per shop you visit often, from the start of the period to its end, with
 * a tick for every visit. Dense stretches are habits, gaps are breaks, and the words say whether the
 * pace is steady, slowing or speeding up.
 */

const dayMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);

export function HabitBarcodes({
  habits,
  from,
  to,
  narrowed = false,
}: {
  habits: Habit[];
  from: string;
  to: string;
  /** Only some hours or part of the map are chosen. */
  narrowed?: boolean;
}) {
  if (habits.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {narrowed
          ? "No shop was visited four or more times at the hours and places chosen."
          : "No shop was visited four or more times in this period."}
      </p>
    );
  }
  const start = dayMs(from);
  const span = Math.max(1, dayMs(to) - start);
  return (
    <ul className="space-y-2">
      {habits.map((h) => (
        <li key={h.merchant} className="grid grid-cols-[10rem_1fr] items-center gap-3 text-sm">
          <div className="min-w-0">
            <div className="truncate font-medium" title={h.merchant}>
              {h.merchant}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {h.visits} visits, {paceText(h)}
            </div>
          </div>
          <svg
            viewBox="0 0 1000 24"
            preserveAspectRatio="none"
            className="h-6 w-full rounded bg-slate-100 dark:bg-slate-800"
            aria-label={`${h.merchant}: ${h.visits} visits`}
          >
            {h.dates.map((d, i) => (
              <rect
                key={`${d}-${i}`}
                x={((dayMs(d) - start) / span) * 998}
                y={3}
                width={2}
                height={18}
                className="fill-blue-600 dark:fill-blue-400"
              />
            ))}
          </svg>
        </li>
      ))}
    </ul>
  );
}
