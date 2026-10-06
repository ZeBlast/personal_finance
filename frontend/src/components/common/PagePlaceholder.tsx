import type { ReactNode } from "react";

export function PagePlaceholder({
  title,
  phase,
  children,
}: {
  title: string;
  phase: string;
  children?: ReactNode;
}) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Not built yet. Planned for {phase}.
      </p>
      {children}
    </section>
  );
}
