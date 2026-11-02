import type { BackendStatus } from "../../hooks/useBackendStatus";

/** The backend stopped while the app was open. Before it first answers, StartupScreen shows instead. */
export function StatusBanner({ status }: { status: BackendStatus }) {
  if (status.state !== "down") return null;

  return (
    <div role="alert" className="bg-red-600 px-4 py-2 text-sm text-white">
      {`Cannot reach the background service. ${status.reason} Close and reopen the app.`}
    </div>
  );
}
