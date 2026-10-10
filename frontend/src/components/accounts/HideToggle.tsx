import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { announceDataChanged } from "../../lib/syncEvents";
import type { Account } from "../../types/api";

const smallButton =
  "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";

/** Says an account is hidden, with a hint about what that means. */
export function HiddenBadge() {
  return (
    <span
      className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200"
      title="Left out of balances, totals, charts and lists. It still syncs, and showing it brings everything back."
    >
      Hidden
    </span>
  );
}

/**
 * A button that hides an account from balances, totals, charts and lists, or shows it again. The
 * account keeps syncing either way, so nothing is lost by hiding it.
 */
export function HideToggle({
  account,
  onChanged,
  onError,
}: {
  account: Account;
  /** Called after the change is saved, so the list can refresh. */
  onChanged: () => void;
  onError?: ((message: string) => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      await api(`/accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: !account.hidden }),
      });
      // Other open pages (balances, charts, the calendar) refresh to match.
      announceDataChanged();
      onChanged();
    } catch (e) {
      onError?.(errorMessage(e, "Could not change that account."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={smallButton}
      disabled={busy}
      aria-label={`${account.hidden ? "Show" : "Hide"} ${account.name}`}
      title={
        account.hidden
          ? "Include this account in balances, totals, charts and lists again."
          : "Leave this account out of balances, totals, charts and lists. It keeps syncing."
      }
      onClick={() => void toggle()}
    >
      {account.hidden ? "Show" : "Hide"}
    </button>
  );
}
