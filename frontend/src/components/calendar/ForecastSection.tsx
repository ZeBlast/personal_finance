import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import type { CalendarForecast, ForecastEvent } from "../../types/calendar";
import { planFromCadence } from "./plannedFromSeries";

const SOURCE: Record<ForecastEvent["source"], string> = {
  expected: "Planned",
  pending: "Pending",
  card_bill: "Card bill (estimated)",
  recurring: "Found recurring",
  debt_plan: "Debt payoff plan",
  goal_plan: "Savings goal",
  budget_allowance: "Budget allowance",
};

const smallButton =
  "rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";

/**
 * A day ahead in the cash forecast: the cash expected in the bank accounts at the end of it, and
 * what changes it that day. A recurring item found in the history can be made a plan (then the
 * plan stands for it) or set aside as not recurring.
 */
export function ForecastSection({
  day,
  lowCash,
  onNotice,
}: {
  day: string;
  lowCash: number;
  onNotice: (n: { kind: "info" | "error"; text: string }) => void;
}) {
  const { data } = useApi<CalendarForecast>(`/calendar/forecast?from=${day}&to=${day}`);
  const [busy, setBusy] = useState(false);
  const d = data?.days[0];
  if (!data || !d) return null;
  const low = d.cashMinor < lowCash;
  const c = data.currency;

  async function act(e: ForecastEvent, what: "plan" | "dismiss"): Promise<void> {
    setBusy(true);
    try {
      if (what === "plan") {
        await api("/planned", {
          method: "POST",
          body: JSON.stringify(planFromCadence(e, day)),
        });
        onNotice({ kind: "info", text: `${e.label} is planned now; the forecast uses the plan.` });
      } else {
        await api("/insights/recurring/dismiss", {
          method: "POST",
          body: JSON.stringify({ key: e.seriesKey, merchant: e.label }),
        });
        onNotice({ kind: "info", text: `${e.label} is no longer treated as recurring.` });
      }
      announceDataChanged();
    } catch (err) {
      onNotice({ kind: "error", text: errorMessage(err, "Could not change that item.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Cash forecast"
      className={`rounded-md border p-2 text-sm ${
        low
          ? "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40"
          : "border-slate-200 dark:border-slate-700"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Cash forecast, bank accounts ({data.accountsCounted})
        </span>
        <span
          className={`font-semibold tabular-nums ${low ? "text-amber-800 dark:text-amber-300" : ""}`}
        >
          {formatMinor(d.cashMinor, c)}
        </span>
      </div>
      {low && (
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
          Below your warning level of {formatMinor(lowCash, c)}. It counts cash only: card debt is
          not taken off until a card bill is due.
        </p>
      )}
      {d.events.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {d.events.map((e, n) => (
            <li key={n} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  {e.label}{" "}
                  <span className="text-slate-500 dark:text-slate-400">· {SOURCE[e.source]}</span>
                </span>
                <span
                  className={`shrink-0 tabular-nums ${e.amountMinor > 0 ? "text-green-700 dark:text-green-400" : ""}`}
                >
                  {e.amountMinor > 0 ? "+" : "−"}
                  {formatMinor(Math.abs(e.amountMinor), c)}
                </span>
              </div>
              {e.source === "recurring" && e.seriesKey && (
                <div className="mt-0.5 flex gap-1">
                  {planFromCadence(e, day) && (
                    <button
                      type="button"
                      className={smallButton}
                      disabled={busy}
                      onClick={() => void act(e, "plan")}
                    >
                      Add as planned
                    </button>
                  )}
                  <button
                    type="button"
                    className={smallButton}
                    disabled={busy}
                    onClick={() => void act(e, "dismiss")}
                  >
                    Not recurring
                  </button>
                </div>
              )}
              {e.source === "card_bill" && (
                <div className="text-slate-500 dark:text-slate-400">
                  What the statement leaves to pay, from the card&apos;s{" "}
                  <Link to="/planning" className="text-blue-600 underline">
                    bill settings
                  </Link>
                  .
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">No change expected.</p>
      )}
    </section>
  );
}
