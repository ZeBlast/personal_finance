import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { summaryPath } from "../../lib/analytics";
import { toDay } from "../../lib/period";
import { formatDay } from "../../lib/time";
import { heatmapWeeks, weekdayAverages, type HeatDay } from "../../lib/views";

const LEVELS = [
  "bg-slate-100 dark:bg-slate-800",
  "bg-blue-200 dark:bg-blue-950",
  "bg-blue-400 dark:bg-blue-800",
  "bg-blue-600 dark:bg-blue-500",
  "bg-blue-900 dark:bg-blue-300",
];

/** The daily summary a heatmap of so many weeks, ending on `end`, is drawn from. */
export function heatmapPath(end: string, weeks: number): string {
  const from = new Date(`${end}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - weeks * 7 - 6);
  return summaryPath({ from: toDay(from), to: end, groupBy: "day" });
}

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const monthName = (date: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });

/**
 * A calendar of the past months shaded by each day's spending, with what each weekday averages. The
 * shades rank days against each other, so one big payment does not wash out the rest. Click a day
 * for its transactions.
 */
export function SpendingHeatmap({
  rows,
  end,
  weeks = 26,
  money,
  showWeekdays = true,
}: {
  rows: Array<{ key: string; spendingMinor: number }>;
  end: string;
  weeks?: number;
  money: (minor: number) => string;
  showWeekdays?: boolean;
}) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<HeatDay | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // When there is not room for every week, show the newest ones.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const toNewest = (): void => {
      element.scrollLeft = element.scrollWidth;
    };
    toNewest();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(toNewest);
    observer.observe(element);
    return () => observer.disconnect();
  }, [weeks]);
  const grid = heatmapWeeks(rows, end, weeks);
  const averages = weekdayAverages(grid);
  const topAverage = Math.max(1, ...averages.map((a) => a.averageMinor));
  const busiest = averages.reduce((a, b) => (b.averageMinor > a.averageMinor ? b : a));
  // A month's name above the first week it starts in.
  const months = grid.map((week, i) => {
    const first = week[0]!.date;
    return i < grid.length - 2 &&
      (i === 0 || first.slice(5, 7) !== grid[i - 1]![0]!.date.slice(5, 7))
      ? monthName(first)
      : "";
  });

  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
      <div className="min-w-0 max-w-full">
        <div ref={scroller} data-heatmap-weeks className="overflow-x-auto">
          <div className="inline-grid grid-cols-[auto_1fr] gap-x-1.5">
            <div />
            <div className="flex gap-[3px]" aria-hidden="true">
              {months.map((m, i) => (
                <span
                  key={i}
                  className="h-4 w-3 overflow-visible text-[10px] whitespace-nowrap text-slate-500 dark:text-slate-400"
                >
                  {m}
                </span>
              ))}
            </div>
            <div className="flex flex-col gap-[3px]" aria-hidden="true">
              {DAY_LABELS.map((d, i) => (
                <span
                  key={i}
                  className="h-3 text-[10px] leading-3 text-slate-500 dark:text-slate-400"
                >
                  {d}
                </span>
              ))}
            </div>
            <div className="flex gap-[3px]" onMouseLeave={() => setHover(null)}>
              {grid.map((week, i) => (
                <div
                  key={week[0]!.date}
                  className="pf-fade-stagger flex flex-col gap-[3px]"
                  style={{ animationDelay: `${(i / grid.length) * 450}ms` }}
                >
                  {week.map((day) =>
                    day.future ? (
                      <span key={day.date} className="h-3 w-3" />
                    ) : (
                      <button
                        key={day.date}
                        type="button"
                        data-level={day.level}
                        aria-label={`${formatDay(day.date)}: ${money(day.spendingMinor)}`}
                        title={`${formatDay(day.date)}: ${money(day.spendingMinor)}`}
                        onFocus={() => setHover(day)}
                        onMouseEnter={() => setHover(day)}
                        onClick={() =>
                          navigate(`/transactions?from=${day.date}&to=${day.date}&direction=out`)
                        }
                        className={`h-3 w-3 rounded-[3px] outline-offset-1 ${LEVELS[day.level]}`}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span role="status" className="min-h-4 text-slate-700 tabular-nums dark:text-slate-200">
            {hover ? `${formatDay(hover.date)}: ${money(hover.spendingMinor)}` : ""}
          </span>
          <span className="inline-flex items-center gap-1">
            Less
            {LEVELS.map((c) => (
              <span key={c} aria-hidden="true" className={`h-3 w-3 rounded-[3px] ${c}`} />
            ))}
            More
          </span>
        </div>
      </div>
      {showWeekdays && (
        <div className="min-w-48 flex-1">
          <p className="text-sm font-medium">By day of the week</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {busiest.averageMinor > 0
              ? `${busiest.day}s run highest, about ${money(busiest.averageMinor)}.`
              : "Nothing spent in this time."}
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {averages.map((a) => (
              <li key={a.day} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-slate-600 dark:text-slate-300">
                  {a.day.slice(0, 3)}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-sm bg-slate-100 dark:bg-slate-800">
                  <span
                    className="pf-grow-x block h-full rounded-sm bg-blue-600 transition-[width] duration-500 dark:bg-blue-400"
                    style={{ width: `${(a.averageMinor / topAverage) * 100}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums">
                  {money(a.averageMinor)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
