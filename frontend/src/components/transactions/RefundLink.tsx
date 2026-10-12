import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Transaction } from "../../types/api";

interface Suggestion {
  transaction: Transaction;
  namesAgree: boolean;
  exactAmount: boolean;
  daysBefore: number;
}

const buttonClass = "rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600";

/**
 * For money coming back: the charge it refunds. Linked, the refund counts against that charge in
 * every total (its month, its category) instead of as money in. For a charge: what has been
 * refunded of it.
 */
export function RefundLink({
  transaction: t,
  onChanged,
}: {
  transaction: Transaction;
  onChanged: (updated: Transaction) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link(originalId: number | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Transaction>(`/transactions/${t.id}/refund-of`, {
        method: "PUT",
        body: JSON.stringify({ originalId }),
      });
      setChoosing(false);
      onChanged(updated);
    } catch (e) {
      setError(errorMessage(e, "Could not change the refund."));
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error && (
    <p role="alert" className="mt-1 text-red-600">
      {error}
    </p>
  );

  // A charge: say what has come back of it.
  if (t.amountMinor > 0) {
    if (t.refundedMinor === 0) return null;
    return (
      <div>
        <p className="block text-sm font-medium">Refunds</p>
        <p className="text-sm">
          {formatMinor(t.refundedMinor, t.currency)} of {formatMinor(t.amountMinor, t.currency)} has
          been refunded. Totals count only what was kept.
        </p>
      </div>
    );
  }

  return (
    <div className="text-sm">
      <p className="block font-medium">Refund of a purchase</p>
      {t.refundOf ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            Gives back <strong>{t.refundOf.merchant}</strong> (
            {formatMinor(t.refundOf.amountMinor, t.currency)},{" "}
            {formatDay(t.refundOf.transactionDate)}, {t.refundOf.accountName}). It counts against
            that purchase&apos;s category and month.{" "}
            <span className="text-xs text-slate-500">
              {t.refundOf.source === "auto"
                ? "Found by the app (same merchant and amount)."
                : "Linked by you."}
            </span>
          </span>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => setChoosing((v) => !v)}
          >
            {choosing ? "Cancel" : "Change"}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void link(null)}
            title="Count it as money in again. The app won't link it automatically again."
          >
            Not a refund
          </button>
        </div>
      ) : (
        !choosing && (
          <button type="button" className={buttonClass} onClick={() => setChoosing(true)}>
            This is a refund of...
          </button>
        )
      )}
      {choosing && <Suggestions transaction={t} busy={busy} onPick={(id) => void link(id)} />}
      {errorLine}
    </div>
  );
}

function Suggestions({
  transaction: t,
  busy,
  onPick,
}: {
  transaction: Transaction;
  busy: boolean;
  onPick: (id: number) => void;
}) {
  const list = useApi<Suggestion[]>(`/transactions/${t.id}/refund-candidates`);
  if (list.error) return <p className="text-red-600">{list.error}</p>;
  if (!list.data) return <p className="text-xs text-slate-500">Looking...</p>;
  const shown = list.data.filter((s) => s.transaction.id !== t.refundOf?.id);
  if (shown.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        No purchase of at least this amount in the 6 months before it.
      </p>
    );
  }
  return (
    <div className="mt-1">
      <p className="text-xs text-slate-500">Pick the purchase this money gives back.</p>
      <ul className="mt-1 divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
        {shown.map(({ transaction: c, namesAgree, exactAmount, daysBefore }) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1">
              <strong>{c.merchant}</strong> · {formatDay(c.authorizedDate ?? c.date)} ·{" "}
              {c.accountName}
              <span className="block text-xs text-slate-500">
                {formatMinor(c.amountMinor, c.currency)}
                {exactAmount ? " · same amount" : ""}
                {namesAgree ? " · same merchant" : ""}
                {` · ${daysBefore} day${daysBefore === 1 ? "" : "s"} before`}
                {c.refundedMinor > 0
                  ? ` · ${formatMinor(c.refundedMinor, c.currency)} already refunded`
                  : ""}
              </span>
            </span>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => onPick(c.id)}
            >
              Link
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
