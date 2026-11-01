import type { BackendStatus } from "../../hooks/useBackendStatus";

/**
 * Shown from the moment the window opens until the backend first answers, so no page asks for data
 * it cannot get yet. If the backend never answers, this is where the user is told what to do.
 */
export function StartupScreen({ status }: { status: Exclude<BackendStatus, { state: "ready" }> }) {
  return (
    <div className="flex h-screen items-center justify-center bg-white p-6 text-center text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      {status.state === "down" ? (
        <div role="alert" className="max-w-md">
          <h1 className="text-lg font-semibold">Personal Finance could not start</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{status.reason}</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Close the app and open it again. If this keeps happening, the details are in
            backend.log, in{" "}
            <span className="break-all">%LOCALAPPDATA%\com.personalfinance.app\logs</span>.
          </p>
        </div>
      ) : (
        <div role="status" className="max-w-md">
          <div
            aria-hidden="true"
            className="mx-auto h-6 w-6 rounded-full border-2 border-slate-200 border-t-blue-600 motion-safe:animate-spin dark:border-slate-700 dark:border-t-blue-400"
          />
          <p className="mt-3 text-sm font-medium">Starting Personal Finance...</p>
          {status.slow && (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This is taking longer than usual. After an update, the app may need a moment to
              prepare your data.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
