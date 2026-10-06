import type { ReactNode } from "react";

/**
 * The card every widget content sits in. Widgets use `WidgetState` for the three situations every
 * widget has (loading, an error, nothing to show), so they all look and behave alike.
 */
export function WidgetState({
  loading,
  error,
  empty,
  emptyText,
  children,
}: {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }
  if (loading) return <p className="text-sm text-slate-500">Loading...</p>;
  if (empty) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {emptyText ?? "Nothing to show yet."}
      </p>
    );
  }
  return <>{children}</>;
}

/** A big number with a small caption, for headline figures. */
export function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: ReactNode;
  tone?: "good" | "bad";
  note?: ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className={`text-2xl font-semibold tabular-nums ${
          tone === "good"
            ? "text-green-700 dark:text-green-400"
            : tone === "bad"
              ? "text-red-600 dark:text-red-400"
              : ""
        }`}
      >
        {value}
      </div>
      {note && <div className="text-xs text-slate-500 dark:text-slate-400">{note}</div>}
    </div>
  );
}
