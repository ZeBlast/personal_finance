import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatDay } from "../../lib/time";
import type {
  PaymentHistory,
  TrackedSubscription,
  TrackedSubscriptionList,
} from "../../types/planning";
import { Loading } from "../common/Loading";
import { ConfirmDialog, Modal } from "../common/Modal";
import { buttonClass } from "../investments/styles";
import { money, todayDay } from "./shared";
import { billingText } from "./subscriptionText";

export function TrackedSection({
  state,
  onEdit,
  onChanged,
}: {
  state: ReturnType<typeof useApi<TrackedSubscriptionList>>;
  onEdit: (s: TrackedSubscription) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TrackedSubscription | null>(null);
  const [payments, setPayments] = useState<TrackedSubscription | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.error}
      </p>
    );
  }
  if (!state.data) return <Loading />;
  const { subscriptions, totals } = state.data;
  const shown = subscriptions.filter((s) => showEnded || !s.ended);

  async function act(path: string, init: RequestInit): Promise<void> {
    try {
      await api(path, init);
      setError(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  return (
    <section aria-labelledby="tracked-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tracked-heading" className="text-lg font-medium">
          Your subscriptions
        </h2>
        <span className="text-sm text-slate-500">
          {totals.active} active · {money(totals.monthlyMinor)} a month ·{" "}
          {money(totals.yearlyMinor)} a year
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {subscriptions.some((s) => s.ended) && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
          />
          Also show cancelled and ended ones
        </label>
      )}
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-600">
          None yet. Add one with “Add a subscription”, or track one found in your history below.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {shown.map((s) => (
            <li
              key={s.id}
              className={`space-y-2 rounded-lg border p-3 text-sm ${
                s.ended
                  ? "border-slate-200 opacity-70 dark:border-slate-700"
                  : "border-slate-200 dark:border-slate-700"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="text-slate-500">{billingText(s)}</div>
                </div>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums">{money(s.monthlyMinor)}</span>
                  <span className="text-xs text-slate-500">a month</span>
                </span>
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300">
                {s.status === "cancelled"
                  ? `Cancelled ${s.cancelledOn ? formatDay(s.cancelledOn) : ""}`
                  : s.ended
                    ? `Ended ${s.endDate ? formatDay(s.endDate) : ""}`
                    : [
                        s.nextCharge && `Next charge ${formatDay(s.nextCharge)}`,
                        s.chargesLeft !== null && `${s.chargesLeft} charges left`,
                        s.endDate && `ends ${formatDay(s.endDate)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                {s.onCalendar ? " · on the calendar" : ""}
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                {s.accountName && <Detail label="Paid from" value={s.accountName} />}
                {s.categoryName && <Detail label="Category" value={s.categoryName} />}
                {s.email && <Detail label="Email" value={s.email} />}
                {s.username && <Detail label="Username" value={s.username} />}
                {s.website && <Detail label="Website" value={s.website} />}
                {s.notes && <Detail label="Notes" value={s.notes} />}
              </dl>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} onClick={() => onEdit(s)}>
                  Edit
                </button>
                <button type="button" className={buttonClass} onClick={() => setPayments(s)}>
                  Payments
                </button>
                {s.status === "active" ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      void act(`/tracked-subscriptions/${s.id}/status`, {
                        method: "POST",
                        body: JSON.stringify({ status: "cancelled", on: todayDay() }),
                      })
                    }
                  >
                    Mark cancelled
                  </button>
                ) : (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      void act(`/tracked-subscriptions/${s.id}/status`, {
                        method: "POST",
                        body: JSON.stringify({ status: "active" }),
                      })
                    }
                  >
                    Active again
                  </button>
                )}
                <button
                  type="button"
                  className={`${buttonClass} text-red-700 dark:text-red-400`}
                  onClick={() => setRemoving(s)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {payments && <PaymentsDialog subscription={payments} onClose={() => setPayments(null)} />}
      {removing && (
        <ConfirmDialog
          title={`Stop tracking ${removing.name}?`}
          message="Its details are removed, and its upcoming charges leave the calendar. Your transactions are not changed."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id;
            setRemoving(null);
            void act(`/tracked-subscriptions/${id}`, { method: "DELETE" });
          }}
        />
      )}
    </section>
  );
}

/** What was paid to a subscription over time; a payment that is not its own can be left out. */
export function PaymentsDialog({
  subscription,
  onClose,
}: {
  subscription: TrackedSubscription;
  onClose: () => void;
}) {
  const path = `/tracked-subscriptions/${subscription.id}/payments`;
  const history = useApi<PaymentHistory>(path);
  const [error, setError] = useState<string | null>(null);

  async function toggle(transactionId: number, excluded: boolean): Promise<void> {
    try {
      await api(`${path}/${transactionId}`, {
        method: "PUT",
        body: JSON.stringify({ excluded }),
      });
      history.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  const h = history.data;
  return (
    <Modal title={`${subscription.name} payments`} onClose={onClose} dismissible>
      <div className="space-y-3 text-sm">
        {h && (
          <p className="text-slate-600 dark:text-slate-300">
            Transactions whose merchant has “{h.match}”
            {h.matchSource === "found" ? " (found in your history)" : ""}. Change what it looks for
            with Edit. {money(h.totalMinor)} paid over the last three years.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {h?.payments.length === 0 && <p className="text-slate-500">No payments found.</p>}
        <ol className="max-h-96 space-y-1 overflow-y-auto">
          {h?.payments.map((p) => (
            <li
              key={p.id}
              className={`flex items-center justify-between gap-2 border-l-2 pl-2 ${p.excluded ? "border-slate-200 opacity-60 dark:border-slate-700" : "border-blue-500"}`}
            >
              <div className="min-w-0">
                <div className={p.excluded ? "line-through" : ""}>
                  {formatDay(p.date)} · {p.merchant}
                </div>
                <div className="text-xs text-slate-500">{p.accountName}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-right tabular-nums">
                  {money(p.amountMinor)}
                  {p.changeMinor !== null && (
                    <span
                      className={`block text-xs ${p.changeMinor > 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}
                    >
                      {p.changeMinor > 0 ? "+" : "−"}
                      {money(Math.abs(p.changeMinor))}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => void toggle(p.id, !p.excluded)}
                >
                  {p.excluded ? "Count it" : "Not this"}
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  );
}

export function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{value}</dd>
    </>
  );
}
