import { Link } from "react-router-dom";
import { useApi } from "../../hooks/useApi";
import type { Settings } from "../../types/api";

/**
 * Across the top while the app uses its built-in sample banks, so made-up figures are never
 * mistaken for real ones.
 */
export function DemoBanner() {
  const settings = useApi<Settings>("/settings");
  if (settings.data?.plaidEnvironment !== "fake") return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-200 bg-violet-50 px-6 py-2 text-sm text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200"
    >
      <span>
        <strong>Sample data.</strong> Banks connected now are made up, to show how the app works.
      </span>
      <Link to="/settings?show=bank" className="font-medium underline">
        Switch to my real accounts
      </Link>
    </div>
  );
}
