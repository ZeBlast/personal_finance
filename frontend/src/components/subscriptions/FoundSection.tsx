import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { CADENCE_LABEL } from "../../lib/insights";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Cadence } from "../../types/insights";
import type {
  RecurringChange,
  Subscription,
  SubscriptionReview,
  SubscriptionStatus,
} from "../../types/planning";
import { Loading } from "../common/Loading";
import { Select } from "../common/Select";

// ---- Found in your history -----------------------------------------------------------------------

export const DECISIONS: Array<{ value: SubscriptionStatus | ""; label: string }> = [
  { value: "", label: "Not decided" },
  { value: "keep", label: "Keep" },
  { value: "cancel", label: "Cancel it" },
  { value: "cancelled", label: "Cancelled" },
];

export function FoundSection({
  state,
  trackedKeys,
  onTrack,
}: {
  state: ReturnType<typeof useApi<SubscriptionReview>>;
  trackedKeys: Set<string | null>;
  onTrack: (s: Subscription) => void;
}) {
  const [showLapsed, setShowLapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.error}
      </p>
    );
  }
  if (!state.data) return <Loading />;
  const data = state.data;
  const cash = (n: number) => formatMinor(n, data.currency);
  const shown = data.subscriptions.filter((s) => showLapsed || s.status === "active");
  const { byKey: changesByKey, other: otherChanges } = splitChanges(
    data.changes,
    new Set(shown.map((s) => s.key)),
  );

  async function decide(s: Subscription, status: SubscriptionStatus | ""): Promise<void> {
    try {
      await api(`/subscriptions/${encodeURIComponent(s.key)}`, {
        method: "PUT",
        body: JSON.stringify({
          merchant: s.merchant,
          status: status === "" ? null : status,
          note: s.review?.note ?? null,
        }),
      });
      setError(null);
      state.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  return (
    <section aria-labelledby="found-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="found-heading" className="text-lg font-medium">
          Found in your history
        </h2>
        <span className="text-sm text-slate-500">
          {cash(data.totals.monthlyMinor)} a month · {cash(data.totals.yearlyMinor)} a year ·{" "}
          {cash(data.totals.toCancelYearlyMinor)} a year marked to cancel
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <RecentChanges changes={otherChanges} money={cash} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showLapsed}
          onChange={(e) => setShowLapsed(e.target.checked)}
        />
        Also show ones that seem to have stopped
      </label>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-1 font-medium">Merchant</th>
              <th className="py-1 font-medium">How often</th>
              <th className="py-1 text-right font-medium">Usual</th>
              <th className="py-1 text-right font-medium">Per year</th>
              <th className="py-1 pl-6 font-medium">Last / next</th>
              <th className="py-1 font-medium">Your decision</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.key} className="border-t border-slate-100 align-top dark:border-slate-800">
                <td className="py-1.5">
                  <div className="font-medium">{s.merchant}</div>
                  <div className="text-xs text-slate-500">{s.accountNames.join(", ")}</div>
                  {s.priceChange && (
                    <div className="text-xs text-amber-700 dark:text-amber-400">
                      Price went from {cash(s.priceChange.fromMinor)} to{" "}
                      {cash(s.priceChange.toMinor)} on {formatDay(s.priceChange.date)}
                    </div>
                  )}
                  {rowBadges(s, changesByKey.get(s.key) ?? []).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {rowBadges(s, changesByKey.get(s.key) ?? []).map((c) => (
                        <ChangeBadge key={c.kind} change={c} money={cash} />
                      ))}
                    </div>
                  )}
                </td>
                <td className="py-1.5">{CADENCE_LABEL[s.cadence as Cadence] ?? s.cadence}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {cash(s.typicalAmountMinor)}
                  {s.amountVaries && <span className="text-xs text-slate-400"> varies</span>}
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums">
                  {cash(s.yearlyMinor)}
                </td>
                <td className="py-1.5 pl-6 text-xs text-slate-500">
                  {formatDay(s.lastDate)}
                  <br />
                  {s.status === "active"
                    ? `next ${formatDay(s.nextExpected)}`
                    : "seems to have stopped"}
                </td>
                <td className="py-1.5">
                  <div className="flex items-center gap-2">
                    <Select
                      aria-label={`Decision for ${s.merchant}`}
                      value={s.review?.status ?? ""}
                      onChange={(e) => void decide(s, e.target.value as SubscriptionStatus | "")}
                      className="rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600"
                    >
                      {DECISIONS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </Select>
                    {trackedKeys.has(s.key) ? (
                      <span className="text-xs text-slate-500">Tracked</span>
                    ) : (
                      <button
                        type="button"
                        className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                        onClick={() => onTrack(s)}
                        title="Add it to your subscriptions, with the details of the account"
                      >
                        Track
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-slate-500">
                  No recurring charges found yet. They show up after a few months of history.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export const CHANGE_TEXT: Record<RecurringChange["kind"], string> = {
  price_up: "Price went up",
  price_down: "Price went down",
  new: "New recurring charge",
  charged_after_cancel: "Still charged after you cancelled it",
};

/**
 * Splits recent changes into those on a row of the table (matched on the series key both share)
 * and those about items not shown there. Pure.
 */
export function splitChanges(
  changes: RecurringChange[],
  shownKeys: Set<string>,
): { byKey: Map<string, RecurringChange[]>; other: RecurringChange[] } {
  const byKey = new Map<string, RecurringChange[]>();
  const other: RecurringChange[] = [];
  for (const c of changes) {
    if (shownKeys.has(c.key)) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
    else other.push(c);
  }
  return { byKey, other };
}

/**
 * The badges for one row: its changes, plus "still charged after you cancelled it" when the row
 * says so but no change does (changes are only made for active ones, and lapsed rows can be
 * shown). Pure.
 */
export function rowBadges(
  s: Pick<Subscription, "key" | "merchant" | "chargedAfterCancel" | "lastDate" | "lastAmountMinor">,
  changes: RecurringChange[],
): RecurringChange[] {
  if (!s.chargedAfterCancel || changes.some((c) => c.kind === "charged_after_cancel")) {
    return changes;
  }
  return [
    ...changes,
    {
      key: s.key,
      merchant: s.merchant,
      kind: "charged_after_cancel",
      date: s.lastDate,
      fromMinor: null,
      toMinor: s.lastAmountMinor,
      yearlyDeltaMinor: 0,
    },
  ];
}

/** What happened to a charge, as a small badge with what it does to the year. */
function ChangeBadge({
  change: c,
  money: cash,
}: {
  change: RecurringChange;
  money: (n: number) => string;
}) {
  const bad = c.kind === "price_up" || c.kind === "charged_after_cancel";
  return (
    <span
      className={`rounded-xl px-2 py-0.5 text-xs font-medium ${
        bad
          ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
          : c.kind === "price_down"
            ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
            : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
      }`}
    >
      {CHANGE_TEXT[c.kind]}
      {c.yearlyDeltaMinor !== 0 &&
        ` · ${c.yearlyDeltaMinor > 0 ? "+" : "−"}${cash(Math.abs(c.yearlyDeltaMinor))} a year`}
    </span>
  );
}

/** Recent changes about items that are not a row in the table above, newest first. */
export function RecentChanges({
  changes,
  money: cash,
}: {
  changes: RecurringChange[];
  money: (n: number) => string;
}) {
  if (changes.length === 0) return null;
  return (
    <section
      aria-label="What changed recently"
      className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
    >
      <h3 className="text-sm font-semibold">What changed recently</h3>
      <ul className="mt-2 space-y-1.5 text-sm">
        {changes.map((c) => (
          <li key={`${c.key}-${c.kind}`}>
            <span className="font-medium">{c.merchant}</span>{" "}
            <ChangeBadge change={c} money={cash} />
            <span className="text-slate-500">
              {" "}
              {c.fromMinor !== null ? `${cash(c.fromMinor)} → ${cash(c.toMinor)}` : cash(c.toMinor)}
              {" · "}
              {c.kind === "new" ? "since" : "on"} {formatDay(c.date)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
