import type { ReactNode } from "react";
import { donutArcs, percent } from "./math";
import { colorAt } from "./palette";

export interface Slice {
  key: string;
  label: string;
  value: number;
  color?: string | null | undefined;
}

const RADIUS = 36;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A donut chart with a legend beside it and an optional label in the middle. */
export function Donut({
  slices,
  format,
  center,
}: {
  slices: Slice[];
  format: (value: number) => string;
  center?: ReactNode;
}) {
  const positive = slices.filter((s) => s.value > 0);
  const total = positive.reduce((sum, s) => sum + s.value, 0);
  const arcs = donutArcs(positive.map((s) => s.value));
  const summary = positive.map((s) => `${s.label} ${format(s.value)}`).join(", ");

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="relative h-36 w-36 shrink-0">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={summary || "No data"}
          className="h-full w-full -rotate-90"
        >
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            strokeWidth="16"
            className="stroke-slate-200 dark:stroke-slate-700"
          />
          {positive.map((slice, index) => {
            const arc = arcs[index]!;
            const length = arc.fraction * CIRCUMFERENCE;
            return (
              <circle
                key={slice.key}
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                strokeWidth="16"
                stroke={slice.color ?? colorAt(index)}
                strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
                strokeDashoffset={-arc.start * CIRCUMFERENCE}
              >
                <title>{`${slice.label}: ${format(slice.value)} (${percent(slice.value, total)}%)`}</title>
              </circle>
            );
          })}
        </svg>
        {center && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            {center}
          </div>
        )}
      </div>
      <ul className="min-w-40 flex-1 space-y-1 text-sm">
        {positive.map((slice, index) => (
          <li key={slice.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: slice.color ?? colorAt(index) }}
              />
              <span className="truncate" title={slice.label}>
                {slice.label}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
              {format(slice.value)} · {percent(slice.value, total)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
