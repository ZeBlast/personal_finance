import { colorAt } from "./palette";

export interface BarRow {
  key: string;
  label: string;
  value: number;
  color?: string | null | undefined;
  note?: string | undefined;
}

/**
 * Horizontal bars with a label and a value on each row. Good for "top N" lists, and readable by
 * screen readers because it is plain text with bars drawn behind it.
 */
export function BarList({
  rows,
  format,
  limit,
}: {
  rows: BarRow[];
  format: (value: number) => string;
  /** Show at most this many rows. */
  limit?: number;
}) {
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  const max = Math.max(1, ...shown.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {shown.map((row, index) => {
        const color = row.color ?? colorAt(index);
        return (
          <li key={row.key} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate" title={row.label}>
                {row.label}
                {row.note ? <span className="ml-1 text-xs text-slate-500">{row.note}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums">{format(row.value)}</span>
            </div>
            <div className="mt-1 h-2 rounded bg-slate-200 dark:bg-slate-700" aria-hidden="true">
              <div
                className="pf-grow-x h-2 rounded transition-[width] duration-500"
                style={{
                  width: `${Math.max(2, (Math.max(0, row.value) / max) * 100)}%`,
                  backgroundColor: color,
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
