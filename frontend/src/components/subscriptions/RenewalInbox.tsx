import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import type { RenewalItem } from "../../types/planning";
import { buttonClass } from "../investments/styles";
import { todayDay } from "./shared";
import { renewalWhen } from "./subscriptionText";

/** Trials ending, yearly renewals, plans ending and price rises: deal with each, then dismiss it. */
export function RenewalInbox({ onOpen }: { onOpen: (subscriptionId: number) => void }) {
  const inbox = useApi<RenewalItem[]>("/renewals");
  const [error, setError] = useState<string | null>(null);
  if (!inbox.data || inbox.data.length === 0) return null;

  async function dismiss(key: string): Promise<void> {
    try {
      await api("/renewals/dismiss", { method: "POST", body: JSON.stringify({ key }) });
      inbox.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not dismiss that."));
    }
  }

  return (
    <section
      aria-labelledby="renewals-heading"
      className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30"
    >
      <h2 id="renewals-heading" className="font-medium">
        Coming up
      </h2>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <ul className="space-y-2 text-sm">
        {inbox.data.map((item) => (
          <li key={item.key} className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium">
                {item.title}{" "}
                <span className="font-normal text-slate-600 dark:text-slate-300">
                  {renewalWhen(item, todayDay())}
                </span>
              </div>
              <div className="text-xs text-slate-500">{item.detail}</div>
            </div>
            <div className="flex gap-2">
              {item.subscriptionId !== null && (
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => onOpen(item.subscriptionId!)}
                >
                  Open
                </button>
              )}
              <button type="button" className={buttonClass} onClick={() => void dismiss(item.key)}>
                Done
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
