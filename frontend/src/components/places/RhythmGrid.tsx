import { cellKey, type Rhythm } from "../../lib/places";

/**
 * The week rhythm: weekdays down, hours across. A circle's size is how many purchases fall in that
 * hour, its colour how much they come to on average. Click hours to choose them; the map and habits
 * then show only purchases at those times.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CELL = 26;
const LEFT = 36;
const TOP = 18;

export function RhythmGrid({
  rhythm,
  chosen,
  onToggle,
  money,
}: {
  rhythm: Rhythm;
  chosen: Set<string>;
  onToggle: (key: string) => void;
  money: (n: number) => string;
}) {
  const averages = rhythm.cells.flat().map((c) => (c.count > 0 ? c.totalMinor / c.count : 0));
  const topAverage = Math.max(1, ...averages);
  const noTime = rhythm.noTime.reduce((n, x) => n + x, 0);
  const width = LEFT + 24 * CELL + (noTime > 0 ? 54 : 0);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${TOP + 7 * CELL + 4}`}
        width={width}
        height={TOP + 7 * CELL + 4}
        className="max-w-none"
        role="group"
        aria-label="Purchases by weekday and hour"
      >
        {[0, 6, 12, 18].map((h) => (
          <text
            key={h}
            x={LEFT + h * CELL + CELL / 2}
            y={12}
            textAnchor="middle"
            className="fill-slate-500 text-[11px]"
          >
            {h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`}
          </text>
        ))}
        {noTime > 0 && (
          <text
            x={LEFT + 24 * CELL + 27}
            y={12}
            textAnchor="middle"
            className="fill-slate-500 text-[11px]"
          >
            No time
          </text>
        )}
        {DAYS.map((day, d) => (
          <g key={day}>
            <text x={0} y={TOP + d * CELL + 15} className="fill-slate-500 text-[11px]">
              {day}
            </text>
            {rhythm.cells[d]!.map((c, h) => {
              const key = cellKey(d, h);
              const on = chosen.has(key);
              const cx = LEFT + h * CELL + CELL / 2;
              const cy = TOP + d * CELL + CELL / 2;
              const r =
                c.count === 0 ? 1.5 : 3 + 7 * Math.sqrt(c.count / Math.max(1, rhythm.maxCount));
              const avg = c.count > 0 ? c.totalMinor / c.count : 0;
              const shade = Math.round(70 - 35 * (avg / topAverage));
              return (
                <g
                  key={key}
                  className="cursor-pointer"
                  onClick={() => onToggle(key)}
                  role="button"
                  aria-pressed={on}
                  aria-label={`${day} ${h}:00, ${c.count} purchases${c.count ? `, ${money(Math.round(avg))} on average` : ""}`}
                >
                  <rect
                    x={cx - CELL / 2 + 1}
                    y={cy - CELL / 2 + 1}
                    width={CELL - 2}
                    height={CELL - 2}
                    rx={4}
                    className={on ? "fill-amber-200 dark:fill-amber-900" : "fill-transparent"}
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={c.count === 0 ? "#cbd5e1" : `hsl(215 75% ${shade}%)`}
                  />
                  <title>
                    {`${day} ${h}:00 — ${c.count} ${c.count === 1 ? "purchase" : "purchases"}${c.count ? `, ${money(Math.round(avg))} on average` : ""}`}
                  </title>
                </g>
              );
            })}
            {noTime > 0 && (
              <text
                x={LEFT + 24 * CELL + 27}
                y={TOP + d * CELL + 15}
                textAnchor="middle"
                className="fill-slate-600 text-[11px] dark:fill-slate-300"
              >
                {rhythm.noTime[d]}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
