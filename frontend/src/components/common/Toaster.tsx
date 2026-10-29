import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { dismissToast, subscribeToasts, type Toast, type ToastKind } from "../../lib/toast";

const STYLE: Record<ToastKind, { Icon: typeof Info; color: string }> = {
  success: { Icon: CircleCheck, color: "text-green-600 dark:text-green-400" },
  info: { Icon: Info, color: "text-blue-600 dark:text-blue-400" },
  warning: { Icon: TriangleAlert, color: "text-amber-600 dark:text-amber-400" },
  error: { Icon: CircleAlert, color: "text-red-600 dark:text-red-400" },
};

/** The pop-up confirmations, bottom right, newest at the bottom. */
export function Toaster() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => {
        const { Icon, color } = STYLE[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="pf-rise-in pointer-events-auto flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-800"
          >
            <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
            <p className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">{t.text}</p>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismissToast(t.id);
                  void t.action!.run();
                }}
                className="shrink-0 rounded px-1.5 font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-slate-700"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              className="shrink-0 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
