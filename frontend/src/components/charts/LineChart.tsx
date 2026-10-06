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

/**
 * A line chart of values observed on particular days. Every observation is drawn as a dot, so
 * sparse data (an app used now and then) is not mistaken for a continuous record; the line only
 * connects the dots. The vertical axis does not have to start at zero.
 */
export function LineChart({
  series,
  format,
  formatAxis,
  gapDays,
}: {
  series: LineSeries[];
  /** Stretches between neighbouring dots this long (or longer) are drawn dashed: nothing was recorded. */
  gapDays?: number;
  format: (value: number) => string;
  formatAxis?: (value: number) => string;
}) {
  const points = series.flatMap((s) => s.points);
  if (points.length === 0) return <p className="text-sm text-slate-500">No data yet.</p>;

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

  const summary = series
    .map(
      (s) =>
        `${s.label}: ${s.points.map((p) => `${shortDate(p.date)} ${format(p.value)}`).join(", ")}`,
    )
    .join("; ");

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary}
        className="h-auto w-full"
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
        {series.map((s) => (
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
            {s.points.map((p) => (
              <circle key={p.date} cx={x(p.date)} cy={y(p.value)} r="3.5" fill={s.color}>
                <title>{`${s.label}, ${shortDate(p.date)}: ${format(p.value)}`}</title>
              </circle>
            ))}
          </g>
        ))}
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
