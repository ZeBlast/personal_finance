import { memo, useCallback, useMemo, useRef, useState, type PointerEvent } from "react";
import { fraction, paddedRange, segmentsOf } from "./math";

export interface LinePoint {
  /** `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: LinePoint[];
}

const WIDTH = 480;
const HEIGHT = 200;
const LEFT = 52;
const RIGHT = 12;
const TOP = 10;
const BOTTOM = 24;
const PLOT_W = WIDTH - LEFT - RIGHT;
const PLOT_H = HEIGHT - TOP - BOTTOM;

const dayMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);

// One formatter for every date label (making one per call is slow).
const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "2-digit",
  timeZone: "UTC",
});
const shortDate = (date: string): string => SHORT_DATE.format(dayMs(date));

/** The index in a sorted list of times closest to `t` (binary search). */
function nearestIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t)) return lo - 1;
  return lo;
}

/** The point of a series on a day, or else its closest one. */
export function pointNear(points: LinePoint[], date: string): LinePoint | undefined {
  if (points.length === 0) return undefined;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return sorted[
    nearestIndex(
      sorted.map((p) => dayMs(p.date)),
      dayMs(date),
    )
  ];
}

interface Layout {
  firstTime: number;
  lastTime: number;
  low: number;
  high: number;
  x: (time: number) => number;
  y: (value: number) => number;
  /** Every day with a point, sorted, with its x position. */
  dates: string[];
  dateX: number[];
  /** Per series: its points sorted by day, and their times, for finding the nearest quickly. */
  lookup: Map<string, { points: LinePoint[]; times: number[] }>;
}

function layoutOf(shown: LineSeries[]): Layout | null {
  let firstTime = Infinity;
  let lastTime = -Infinity;
  let min = Infinity;
  let max = -Infinity;
  const days = new Set<string>();
  const lookup: Layout["lookup"] = new Map();
  for (const s of shown) {
    const points = [...s.points].sort((a, b) => a.date.localeCompare(b.date));
    const times = points.map((p) => dayMs(p.date));
    lookup.set(s.key, { points, times });
    for (let i = 0; i < points.length; i++) {
      const t = times[i]!;
      const v = points[i]!.value;
      if (t < firstTime) firstTime = t;
      if (t > lastTime) lastTime = t;
      if (v < min) min = v;
      if (v > max) max = v;
      days.add(points[i]!.date);
    }
  }
  if (days.size === 0) return null;
  const { low, high } = paddedRange(min, max);
  const x = (time: number) => LEFT + fraction(time, firstTime, lastTime) * PLOT_W;
  const y = (value: number) => TOP + (1 - fraction(value, low, high)) * PLOT_H;
  const dates = [...days].sort();
  return {
    firstTime,
    lastTime,
    low,
    high,
    x,
    y,
    dates,
    dateX: dates.map((d) => x(dayMs(d))),
    lookup,
  };
}

/**
 * The parts that do not change while hovering: the grid, the axis labels, and the lines (one path
 * per line, with dashed parts for gaps, rather than one element per segment).
 */
const ChartBody = memo(function ChartBody({
  shown,
  layout,
  axis,
  gapDays,
  showDots,
}: {
  shown: LineSeries[];
  layout: Layout;
  axis: (value: number) => string;
  gapDays: number | undefined;
  showDots: boolean;
}) {
  const { x, y, low, high, firstTime, lastTime } = layout;
  const gridValues = [0, 1, 2, 3].map((i) => low + ((high - low) * i) / 3);
  return (
    <>
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
      {shown.map((s) => {
        const points = layout.lookup.get(s.key)?.points ?? [];
        let solid = "";
        let dashed = "";
        for (const seg of segmentsOf(points, gapDays)) {
          const part = `M${x(dayMs(seg.from.date)).toFixed(1)},${y(seg.from.value).toFixed(1)}L${x(dayMs(seg.to.date)).toFixed(1)},${y(seg.to.value).toFixed(1)}`;
          if (seg.gap) dashed += part;
          else solid += part;
        }
        return (
          <g key={s.key}>
            {solid && (
              <path
                d={solid}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {dashed && (
              <path
                d={dashed}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="3 5"
                opacity={0.6}
              />
            )}
            {showDots &&
              points.map((p) => (
                <circle key={p.date} cx={x(dayMs(p.date))} cy={y(p.value)} r="3.5" fill={s.color} />
              ))}
          </g>
        );
      })}
      <text
        x={firstTime === lastTime ? LEFT + PLOT_W / 2 : LEFT}
        y={HEIGHT - 8}
        textAnchor={firstTime === lastTime ? "middle" : "start"}
        className="fill-slate-500 text-[9px]"
      >
        {SHORT_DATE.format(firstTime)}
      </text>
      {firstTime !== lastTime && (
        <text
          x={WIDTH - RIGHT}
          y={HEIGHT - 8}
          textAnchor="end"
          className="fill-slate-500 text-[9px]"
        >
          {SHORT_DATE.format(lastTime)}
        </text>
      )}
    </>
  );
});

/**
 * A line chart of values observed on particular days. Every observation is drawn as a dot, so
 * sparse data (an app used now and then) is not mistaken for a continuous record; the line only
 * connects the dots. The vertical axis does not have to start at zero.
 *
 * Hovering (or the arrow keys, once focused) shows each line's exact figure on the nearest day;
 * clicking a legend entry hides or shows that line. Hovering only redraws the guide line and the
 * readout; the lines themselves are drawn once.
 */
export function LineChart({
  series,
  format,
  formatAxis,
  gapDays,
  dots,
}: {
  series: LineSeries[];
  /** Draw a dot on every point. By default only when there are few enough for that to read well. */
  dots?: boolean;
  /** Stretches between neighbouring dots this long (or longer) are drawn dashed: nothing was recorded. */
  gapDays?: number;
  format: (value: number) => string;
  formatAxis?: (value: number) => string;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** The index (in `layout.dates`) of the day under the pointer. */
  const [hover, setHover] = useState<number | null>(null);
  const frame = useRef(0);

  const shown = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
  const layout = useMemo(() => layoutOf(shown), [shown]);
  const showDots = dots ?? shown.every((s) => s.points.length <= 40);
  const axis = formatAxis ?? format;

  // A short description for screen readers: each line's range, not every point.
  const summary = useMemo(() => {
    if (!layout) return "";
    return shown
      .map((s) => {
        const pts = layout.lookup.get(s.key)?.points ?? [];
        if (pts.length === 0) return `${s.label}: no data`;
        const first = pts[0]!;
        const last = pts[pts.length - 1]!;
        return `${s.label}: ${format(first.value)} on ${shortDate(first.date)} to ${format(last.value)} on ${shortDate(last.date)}`;
      })
      .join("; ");
  }, [layout, shown, format]);

  // The day under the pointer, at most once a frame.
  const onMove = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      if (!layout) return;
      const box = e.currentTarget.getBoundingClientRect();
      if (box.width === 0) return;
      const vx = ((e.clientX - box.left) / box.width) * WIDTH;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const i = nearestIndex(layout.dateX, vx);
        setHover((prev) => (prev === i ? prev : i));
      });
    },
    [layout],
  );
  const leave = useCallback(() => {
    cancelAnimationFrame(frame.current);
    setHover(null);
  }, []);

  if (!layout) return <p className="text-sm text-slate-500">No data yet.</p>;

  const toggle = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else if (series.length - next.size > 1) next.add(key); // always keep one line
      return next;
    });
  const step = (by: number) => {
    const last = layout.dates.length - 1;
    const i = hover === null ? (by > 0 ? 0 : last) : Math.min(last, Math.max(0, hover + by));
    setHover(i);
  };

  const hoverDate =
    hover === null ? null : (layout.dates[Math.min(hover, layout.dates.length - 1)] ?? null);
  const readout =
    hoverDate === null
      ? []
      : shown.flatMap((s) => {
          const l = layout.lookup.get(s.key);
          if (!l || l.points.length === 0) return [];
          return [{ s, p: l.points[nearestIndex(l.times, dayMs(hoverDate))]! }];
        });
  const hoverX = hoverDate === null ? 0 : layout.x(dayMs(hoverDate));
  const share = hoverX / WIDTH;

  return (
    <div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={summary}
          tabIndex={0}
          className="h-auto w-full cursor-crosshair touch-none rounded outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={leave}
          onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              step(e.key === "ArrowLeft" ? -1 : 1);
            } else if (e.key === "Escape") leave();
          }}
        >
          <ChartBody
            shown={shown}
            layout={layout}
            axis={axis}
            gapDays={gapDays}
            showDots={showDots}
          />
          {hoverDate !== null && (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={TOP}
                y2={TOP + PLOT_H}
                className="stroke-slate-400 dark:stroke-slate-500"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {readout.map(({ s, p }) => (
                <circle
                  key={s.key}
                  cx={layout.x(dayMs(p.date))}
                  cy={layout.y(p.value)}
                  r="4.5"
                  fill={s.color}
                  className="stroke-white dark:stroke-slate-900"
                  strokeWidth="2"
                />
              ))}
            </g>
          )}
        </svg>
        {hoverDate !== null && readout.length > 0 && (
          <div
            role="status"
            className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-slate-200 bg-white/95 px-2.5 py-1.5 text-xs shadow-md dark:border-slate-600 dark:bg-slate-800/95"
            // Beside the guide line, on whichever side has more room.
            style={
              share > 0.6 ? { right: `${(1 - share) * 100 + 2}%` } : { left: `${share * 100 + 2}%` }
            }
          >
            <div className="mb-0.5 font-medium">{shortDate(hoverDate)}</div>
            {readout.map(({ s, p }) => (
              <div key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.label}
                  {p.date !== hoverDate && (
                    <span className="text-slate-400">({shortDate(p.date)})</span>
                  )}
                </span>
                <span className="font-medium tabular-nums">{format(p.value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {series.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300">
          {series.map((s) => {
            const off = hidden.has(s.key);
            return (
              <li key={s.key}>
                <button
                  type="button"
                  aria-pressed={!off}
                  title={off ? `Show ${s.label}` : `Hide ${s.label}`}
                  onClick={() => toggle(s.key)}
                  className={`flex items-center gap-1 hover:underline ${off ? "line-through opacity-40" : ""}`}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
