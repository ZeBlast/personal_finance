/** A labelled horizontal progress bar. `value` above `max` fills the bar and turns it red. */
export function ProgressBar({
  value,
  max,
  label,
  color,
}: {
  value: number;
  max: number;
  label: string;
  color?: string | null | undefined;
}) {
  const over = value > max;
  const fill = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(value, 0), max)}
      className="h-2 rounded bg-slate-200 dark:bg-slate-700"
    >
      <div
        className="h-2 rounded"
        style={{ width: `${fill}%`, backgroundColor: over ? "#dc2626" : (color ?? "#2563eb") }}
      />
    </div>
  );
}
