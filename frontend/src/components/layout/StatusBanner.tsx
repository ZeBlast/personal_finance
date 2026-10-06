import type { BackendStatus } from "../../hooks/useBackendStatus";

export function StatusBanner({ status }: { status: BackendStatus }) {
  if (status.state === "ready") return null;

  const isDown = status.state === "down";
  return (
    <div
      role="alert"
      className={`px-4 py-2 text-sm ${
        isDown ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"
      }`}
    >
      {isDown
        ? `Cannot reach the background service. ${status.reason} Close and reopen the app.`
        : "Starting the background service..."}
    </div>
  );
}
