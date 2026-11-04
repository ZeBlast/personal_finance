import type { ReactNode } from "react";

/**
 * A page's instructions, tucked away until asked for: one collapsed "How this works" line under
 * the page's subtitle, styled like the dashboard's "How this is worked out".
 */
export function HowThisWorks({ children }: { children: ReactNode }) {
  return (
    <details className="mt-1 text-xs text-slate-500 dark:text-slate-400">
      <summary className="cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-300">
        ⓘ How this works
      </summary>
      <div className="mt-1 max-w-3xl space-y-1">{children}</div>
    </details>
  );
}
