import { useState, type PointerEvent } from "react";
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

const dayMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);

function shortDate(date: string): string {
  return new Date(dayMs(date)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  });
}

/** The point of a series on a day, or else its closest one. */
export function pointNear(points: LinePoint[], date: string): LinePoint | undefined {
  const t = dayMs(date);
  let best: LinePoint | undefined;
  for (const p of points) {
    if (!best || Math.abs(dayMs(p.date) - t) < Math.abs(dayMs(best.date) - t)) best = p;
  }
  return best;
}

/**
 * A line chart of values observed on particular days. Every observation is drawn as a dot, so
 * sparse data (an app used now and then) is not mistaken for a continuous record; the line only
 * connects the dots. The vertical axis does not have to start at zero.
 *
 * Hovering (or the arrow keys, once focused) shows each line's exact figure on the nearest day;
 * clicking a legend entry hides or shows that line.
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
  const [hover, setHover] = useState<string | null>(null);
  const shown = series.filter((s) => !hidden.has(s.key));
  const points = shown.flatMap((s) => s.points);
  const showDots = dots ?? shown.every((s) => s.points.length <= 40);
  if (points.length === 0) return <p className="text-sm text-slate-500">No data yet.</p>;

  const toggle = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else if (series.length - next.size > 1) next.add(key); // always keep one line
      return next;
    });

  const times = points.map((p) => dayMs(p.date));
  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const { low, high } = paddedRange(
    Math.min(...points.map((p) => p.value)),
    Math.max(...points.map((p) => p.value)),
  );

  const plotW = WIDTH - LEFT - RIGHT;
  const plotH = HEIGHT - TOP - BOTTOM;
  const x = (date: string): number => LEFT + fraction(dayMs(date), firstTime, lastTime) * plotW;
  const y = (value: number): number => TOP + (1 - fraction(value, low, high)) * plotH;
  const axis = formatAxis ?? format;
  const gridValues = [0, 1, 2, 3].map((i) => low + ((high - low) * i) / 3);
  const firstDate = new Date(firstTime).toISOString().slice(0, 10);
  const lastDate = new Date(lastTime).toISOString().slice(0, 10);
  const dates = [...new Set(points.map((p) => p.date))].sort();

  // The day under the pointer: the nearest one with a point.
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const vx = ((e.clientX - box.left) / box.width) * WIDTH;
    let best: string | null = null;
    for (const d of dates) {
      if (best === null || Math.abs(x(d) - vx) < Math.abs(x(best) - vx)) best = d;
    }
    setHover(best);
  };
  const step = (by: number) => {
    const at = hover === null ? -1 : dates.indexOf(hover);
    const i = at === -1 ? (by > 0 ? 0 : dates.length - 1) : at + by;
    const next = dates[Math.min(dates.length - 1, Math.max(0, i))];
    if (next) setHover(next);
  };
  const readout =
    hover === null
      ? []
      : shown
          .map((s) => ({ s, p: pointNear(s.points, hover) }))
          .filter((r): r is { s: LineSeries; p: LinePoint } => r.p !== undefined);
  const hoverX = hover === null ? 0 : x(hover);
  const share = hoverX / WIDTH;

  const summary = shown
    .map(
      (s) =>
        `${s.label}: ${s.points.map((p) => `${shortDate(p.date)} ${format(p.value)}`).join(", ")}`,
    )
    .join("; ");

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
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              step(e.key === "ArrowLeft" ? -1 : 1);
            } else if (e.key === "Escape") setHover(null);
          }}
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
          {shown.map((s) => (
            <g key={s.key}>
              {segmentsOf(s.points, gapDays).map((seg) => (
                <line
                  key={seg.from.date}
                  x1={x(seg.from.date)}
                  y1={y(seg.from.value)}
                  x2={x(seg.to.date)}
                  y2={y(seg.to.value)}
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={seg.gap ? "3 5" : undefined}
                  opacity={seg.gap ? 0.6 : 1}
                />
              ))}
              {(showDots ? s.points : []).map((p) => (
                <circle key={p.date} cx={x(p.date)} cy={y(p.value)} r="3.5" fill={s.color} />
              ))}
            </g>
          ))}
          {hover !== null && (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={TOP}
                y2={TOP + plotH}
                className="stroke-slate-400 dark:stroke-slate-500"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {readout.map(({ s, p }) => (
                <circle
                  key={s.key}
                  cx={x(p.date)}
                  cy={y(p.value)}
                  r="4.5"
                  fill={s.color}
                  className="stroke-white dark:stroke-slate-900"
                  strokeWidth="2"
                />
              ))}
            </g>
          )}
          <text
            x={firstTime === lastTime ? LEFT + plotW / 2 : LEFT}
            y={HEIGHT - 8}
            textAnchor={firstTime === lastTime ? "middle" : "start"}
            className="fill-slate-500 text-[9px]"
          >
            {shortDate(firstDate)}
          </text>
          {firstTime !== lastTime && (
            <text
              x={WIDTH - RIGHT}
              y={HEIGHT - 8}
              textAnchor="end"
              className="fill-slate-500 text-[9px]"
            >
              {shortDate(lastDate)}
            </text>
          )}
        </svg>
        {hover !== null && readout.length > 0 && (
          <div
            role="status"
            className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-slate-200 bg-white/95 px-2.5 py-1.5 text-xs shadow-md dark:border-slate-600 dark:bg-slate-800/95"
            // Beside the guide line, on whichever side has more room.
            style={
              share > 0.6 ? { right: `${(1 - share) * 100 + 2}%` } : { left: `${share * 100 + 2}%` }
            }
          >
            <div className="mb-0.5 font-medium">{shortDate(hover)}</div>
            {readout.map(({ s, p }) => (
              <div key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.label}
                  {p.date !== hover && (
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
