import { niceMax, ticks } from "./math";

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
}

export interface ColumnGroup {
  key: string;
  label: string;
  /** One value per series, in the same order. */
  values: number[];
}

const WIDTH = 480;
const HEIGHT = 200;
const LEFT = 52;
const RIGHT = 8;
const TOP = 10;
const BOTTOM = 24;

/**
 * Columns grouped by period (one column per series), with a labelled axis, a zero line, and a tooltip
 * on each column. Negative values hang below the zero line, which is what a net cash-flow chart needs.
 * `colorFor` lets a series change color by value (for example green above zero, red below).
 */
export function ColumnChart({
  series,
  groups,
  format,
  formatAxis,
  colorFor,
  fit = false,
}: {
  series: ColumnSeries[];
  groups: ColumnGroup[];
  format: (value: number) => string;
  formatAxis?: (value: number) => string;
  colorFor?: (value: number, seriesIndex: number) => string;
  /**
   * Shrink to fit the height of the box it is in (keeping its shape), legend included, instead of
   * growing with its width. For a dashboard widget that may be short and wide.
   */
  fit?: boolean;
}) {
  const all = groups.flatMap((g) => g.values);
  const top = niceMax(Math.max(0, ...all));
  const lowest = Math.min(0, ...all);
  const bottom = lowest < 0 ? -niceMax(-lowest) : 0;
  const span = top - bottom || 1;

  const plotW = WIDTH - LEFT - RIGHT;
  const plotH = HEIGHT - TOP - BOTTOM;
  const y = (value: number): number => TOP + ((top - value) / span) * plotH;
  const zero = y(0);

  const groupW = plotW / Math.max(1, groups.length);
  const barW = Math.min(28, (groupW * 0.7) / Math.max(1, series.length));
  const axis = formatAxis ?? format;
  const gridValues = [...ticks(top, 4), ...(bottom < 0 ? [bottom] : [])];

  const summary = groups
    .map(
      (g) =>
        `${g.label}: ${series.map((s, i) => `${s.label} ${format(g.values[i] ?? 0)}`).join(", ")}`,
    )
    .join("; ");

  return (
    <div className={fit ? "flex h-full min-h-0 flex-col" : undefined}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary || "No data"}
        className={fit ? "min-h-0 w-full flex-1" : "h-auto w-full"}
      >
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={LEFT}
              x2={WIDTH - RIGHT}
              y1={y(value)}
              y2={y(value)}
              className="stroke-slate-200 dark:stroke-slate-700"
              strokeWidth="1"
            />
            <text
              x={LEFT - 6}
              y={y(value) + 3}
              textAnchor="end"
              className="fill-slate-500 text-[9px]"
            >
              {axis(value)}
            </text>
          </g>
        ))}
        <line
          x1={LEFT}
          x2={WIDTH - RIGHT}
          y1={zero}
          y2={zero}
          className="stroke-slate-400"
          strokeWidth="1"
        />
        {groups.map((group, gi) => {
          const groupX = LEFT + gi * groupW;
          const used = barW * series.length;
          const startX = groupX + (groupW - used) / 2;
          return (
            <g key={group.key}>
              {series.map((s, si) => {
                const value = group.values[si] ?? 0;
                const barTop = Math.min(y(value), zero);
                const height = Math.max(Math.abs(y(value) - zero), value === 0 ? 0 : 1);
                return (
                  <rect
                    key={s.key}
                    className="pf-grow-up"
                    x={startX + si * barW}
                    y={barTop}
                    width={Math.max(1, barW - 2)}
                    height={height}
                    rx="2"
                    fill={colorFor ? colorFor(value, si) : s.color}
                  >
                    <title>{`${group.label}, ${s.label}: ${format(value)}`}</title>
                  </rect>
                );
              })}
              <text
                x={groupX + groupW / 2}
                y={HEIGHT - 8}
                textAnchor="middle"
                className="fill-slate-500 text-[9px]"
              >
                {group.label}
              </text>
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
