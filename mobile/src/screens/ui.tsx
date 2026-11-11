import type { ReactNode } from "react";

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 pt-4 pb-24">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      {title && <h2 className="font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Notice({
  kind,
  children,
}: {
  kind: "error" | "warning" | "info";
  children: ReactNode;
}) {
  const style = {
    error:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
    warning:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
    info: "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
  }[kind];
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={`rounded-lg border px-3 py-2 text-sm ${style}`}
    >
      {children}
    </p>
  );
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`block min-h-12 w-full rounded-lg px-4 text-base font-medium disabled:opacity-60 ${
        primary
          ? "bg-blue-600 text-white active:bg-blue-700"
          : "border border-slate-300 active:bg-slate-100 dark:border-slate-600 dark:active:bg-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

/** A thin bar: how much of a cap is used, red past it. */
export function Meter({ percent, over }: { percent: number; over: boolean }) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
      <div
        className={`h-full rounded-full ${over ? "bg-red-500" : percent >= 90 ? "bg-amber-500" : "bg-green-600"}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
