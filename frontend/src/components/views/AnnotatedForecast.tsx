import { useState } from "react";
import { useMeasuredWidth } from "../../hooks/useMeasuredWidth";
import { formatAxisMoney, formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import { lowestOf, lowestTile, withExtraSpend } from "../../lib/views";
import type { Forecast, ForecastDay } from "../../types/planning";

const PAD = { left: 56, right: 12, top: 26, bottom: 24 };

/** A line that holds each day's balance until the next day, because money moves in steps. Pure. */
export function stepLine(points: Array<{ x: number; y: number }>): string {
  return points.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `H${p.x}V${p.y}`)).join("");
}

/**
 * The days ahead: cash as steps, the lowest point named, and a mark on each day money moves. Hover a
 * day for its figures. With `whatIf`, a slider tries out a one-off purchase and draws the result.
 */
export function AnnotatedForecast({
  forecast,
  height = 300,
  whatIf = true,
  compare = null,
}: {
  forecast: Forecast;
  height?: number;
  whatIf?: boolean;
  /** A saved scenario's days, drawn as a second dashed line over the same window. */
  compare?: { label: string; days: ForecastDay[] } | null;
}) {
  const { ref, width } = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [extra, setExtra] = useState(0);
  const [day, setDay] = useState(forecast.days[0]?.date ?? forecast.today);
  const money = (n: number) => formatMinor(n, forecast.currency);
  const days = forecast.days;
  if (days.length === 0) return null;

  const tried = extra > 0 ? withExtraSpend(days, extra, day) : null;
  const triedLow = tried ? lowestOf(tried) : null;
  const other = compare && compare.days.length > 0 ? compare : null;
  const values = [
    ...days.map((d) => d.balanceMinor),
    ...(tried ?? []).map((d) => d.balanceMinor),
    ...(other?.days ?? []).map((d) => d.balanceMinor),
  ];
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const x = (i: number) => PAD.left + (i / Math.max(1, days.length - 1)) * plotWidth;
  const y = (v: number) => PAD.top + ((top - v) / span) * (height - PAD.top - PAD.bottom);
  const line = stepLine(days.map((d, i) => ({ x: x(i), y: y(d.balanceMinor) })));
  // The same point the Planning tile names: when the lowest is today, the lowest after it.
  const low = lowestTile(forecast);
  const lowName = low.afterToday ? "Lowest after today" : "Lowest";
  const lowAt = days.findIndex((d) => d.date === low.date);
  const lowOnRight = lowAt >= 0 && x(lowAt) > width - 200;
  // Always above the line, and at least 8px clear of the axis or baseline under it.
  const lowLabelY = y(low.balanceMinor) - 8;
  // Top and zero, then the bottom or the middle, whichever has room for its label.
  const ticks = [...new Set([top, 0, Math.abs(y(bottom) - y(0)) > 16 ? bottom : top / 2])];
  const shown = hover === null ? null : days[hover]!;
  // A sensible range for the slider: up to what is in the bank, at least $500.
  const sliderMax = Math.max(50_000, Math.ceil(forecast.startBalanceMinor / 10_000) * 10_000);

  return (
    <div className="space-y-3">
      <div ref={ref} className="relative">
        <svg
          role="img"
          aria-label={`Cash over the next ${days.length} days, from ${money(forecast.startBalanceMinor)} to ${money(forecast.endBalanceMinor)}. ${lowName} ${money(low.balanceMinor)} on ${formatDay(low.date)}. The table below lists each day money moves.`}
          width={width}
          height={height}
          className="block"
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const at = ((e.clientX - box.left - PAD.left) / plotWidth) * (days.length - 1);
            setHover(Math.max(0, Math.min(days.length - 1, Math.round(at))));
          }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(v)}
                y2={y(v)}
                className={
                  v === 0
                    ? "stroke-slate-400 dark:stroke-slate-500"
                    : "stroke-slate-200 dark:stroke-slate-700"
                }
              />
              <text
                x={PAD.left - 8}
                y={y(v) + 4}
                textAnchor="end"
                className="fill-slate-500 text-[11px] tabular-nums dark:fill-slate-400"
              >
                {formatAxisMoney(v)}
              </text>
            </g>
          ))}
          <text
            x={PAD.left}
            y={height - 6}
            className="fill-slate-500 text-[11px] dark:fill-slate-400"
          >
            {formatDay(days[0]!.date)}
          </text>
          <text
            x={width - PAD.right}
            y={height - 6}
            textAnchor="end"
            className="fill-slate-500 text-[11px] dark:fill-slate-400"
          >
            {formatDay(days[days.length - 1]!.date)}
          </text>
          {other && (
            <path
              data-testid="scenario-line"
              d={stepLine(other.days.map((d, i) => ({ x: x(i), y: y(d.balanceMinor) })))}
              fill="none"
              strokeWidth={2}
              strokeDasharray="7 4"
              className="stroke-violet-500 dark:stroke-violet-400"
            />
          )}
          {tried && (
            <path
              data-testid="what-if-line"
              d={stepLine(tried.map((d, i) => ({ x: x(i), y: y(d.balanceMinor) })))}
              fill="none"
              strokeWidth={2}
              strokeDasharray="5 4"
              className="stroke-amber-500"
            />
          )}
          <path
            d={line}
            pathLength={1}
            fill="none"
            strokeWidth={2}
            className="pf-draw stroke-blue-600 dark:stroke-blue-400"
          />
          {days.map((d, i) =>
            d.events.length === 0 ? null : (
              <circle
                key={d.date}
                data-testid="event-mark"
                cx={x(i)}
                cy={y(d.balanceMinor)}
                r={4}
                strokeWidth={2}
                className={`pf-fade-late stroke-white dark:stroke-slate-900 ${d.changeMinor < 0 ? "fill-red-600 dark:fill-red-400" : "fill-green-600 dark:fill-green-400"}`}
              />
            ),
          )}
          {lowAt >= 0 && (
            <text
              x={lowOnRight ? x(lowAt) - 6 : x(lowAt) + 6}
              y={lowLabelY}
              textAnchor={lowOnRight ? "end" : "start"}
              strokeWidth={3}
              style={{ paintOrder: "stroke" }}
              className="pf-fade-late fill-slate-900 stroke-white text-xs font-semibold tabular-nums dark:fill-slate-100 dark:stroke-slate-900"
            >
              {lowName} {money(low.balanceMinor)}, {formatDay(low.date)}
            </text>
          )}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              className="stroke-slate-400"
            />
          )}
        </svg>
        {shown && hover !== null && (
          <div
            style={{ left: Math.max(0, Math.min(x(hover) + 10, width - 228)), top: 2 }}
            className="pointer-events-none absolute z-10 w-56 rounded-md border border-slate-200 bg-white p-2 text-xs shadow-md dark:border-slate-700 dark:bg-slate-800"
          >
            <div className="font-semibold">{formatDay(shown.date)}</div>
            <div className="tabular-nums">{money(shown.balanceMinor)} in the bank</div>
            {other?.days[hover] && (
              <div className="tabular-nums text-violet-700 dark:text-violet-300">
                {money(other.days[hover].balanceMinor)} with {other.label}
              </div>
            )}
            {shown.events.slice(0, 4).map((e, i) => (
              <div
                key={`${e.label}-${i}`}
                className="flex justify-between gap-2 text-slate-600 dark:text-slate-300"
              >
                <span className="truncate">{e.label}</span>
                <span className="tabular-nums">{money(e.amountMinor)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-full bg-green-600 dark:bg-green-400"
          />
          Money in
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-full bg-red-600 dark:bg-red-400"
          />
          Money out
        </span>
        {other && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 bg-violet-500 dark:bg-violet-400" />
            With {other.label}
          </span>
        )}
        {tried && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 bg-amber-500" />
            With the extra purchase
          </span>
        )}
      </p>
      {whatIf && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex min-w-56 flex-1 items-center gap-2">
            <span className="shrink-0">What if I spend</span>
            <input
              type="range"
              min={0}
              max={sliderMax}
              step={1000}
              value={Math.min(extra, sliderMax)}
              onChange={(e) => setExtra(Number(e.target.value))}
              className="min-w-24 flex-1"
            />
            <span className="w-20 shrink-0 text-right font-medium tabular-nums">
              {money(extra)}
            </span>
          </label>
          <label className="flex items-center gap-2">
            on
            <input
              type="date"
              value={day}
              min={days[0]!.date}
              max={days[days.length - 1]!.date}
              onChange={(e) => {
                if (e.target.value) setDay(e.target.value);
              }}
              className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
            />
          </label>
          {triedLow && (
            <p
              role="status"
              className={`w-full ${triedLow.balanceMinor < 0 ? "font-medium text-red-700 dark:text-red-400" : "text-slate-600 dark:text-slate-300"}`}
            >
              {triedLow.balanceMinor < 0
                ? `That takes cash to ${money(triedLow.balanceMinor)} on ${formatDay(triedLow.date)}.`
                : `The lowest point would be ${money(triedLow.balanceMinor)} on ${formatDay(triedLow.date)}.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
