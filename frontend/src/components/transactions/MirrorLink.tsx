import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Transaction } from "../../types/api";

interface Suggestion {
  transaction: Transaction;
  exactAmount: boolean;
  namesAgree: boolean;
  daysApart: number;
}

const buttonClass = "rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600";

/**
 * The same purchase shown on two accounts, such as a PayPal purchase and the card charge that paid
 * for it. Linked, one counts and the other is a copy left out of totals; the link can be undone,
 * or made by hand from suggestions on other accounts.
 */
export function MirrorLink({
  transaction: t,
  onChanged,
}: {
  transaction: Transaction;
  onChanged: (updated: Transaction) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(method: "POST" | "DELETE", otherId?: number): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Transaction>(`/transactions/${t.id}/mirror`, {
        method,
        ...(otherId === undefined ? {} : { body: JSON.stringify({ otherId }) }),
      });
      setChoosing(false);
      onChanged(updated);
    } catch (e) {
      setError(errorMessage(e, "Could not change the link."));
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error && (
    <p role="alert" className="mt-1 text-red-600">
      {error}
    </p>
  );

  if (t.mirror) {
    const other = t.mirror.with;
    return (
      <div className="text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {t.mirror.role === "copy" ? (
              <>
                Same purchase as on <strong>{other.accountName}</strong> ({other.merchant},{" "}
                {formatDay(other.transactionDate)}), which counts it. This copy is left out of
                totals.
              </>
            ) : (
              <>
                Also shown on <strong>{other.accountName}</strong> ({other.merchant},{" "}
                {formatDay(other.transactionDate)}). That copy is left out of totals; this one
                counts.
              </>
            )}{" "}
            <span className="text-xs text-slate-500">
              {t.mirror.source === "auto" ? "Linked by the app." : "Linked by you."}
            </span>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("DELETE")}
            className={buttonClass}
            title="Count both again. The app won't link these automatically again."
          >
            {busy ? "Unlinking..." : "Not the same purchase"}
          </button>
        </div>
        {errorLine}
      </div>
    );
  }

  if (t.transferWith || t.amountMinor === 0) return null;
  return (
    <div className="text-sm">
      {!choosing ? (
        <button type="button" onClick={() => setChoosing(true)} className={buttonClass}>
          Same purchase as on another account...
        </button>
      ) : (
        <Suggestions transaction={t} busy={busy} onLink={(otherId) => void run("POST", otherId)} />
      )}
      {errorLine}
    </div>
  );
}

function Suggestions({
  transaction: t,
  busy,
  onLink,
}: {
  transaction: Transaction;
  busy: boolean;
  onLink: (otherId: number) => void;
}) {
  const suggestions = useApi<Suggestion[]>(`/transactions/${t.id}/mirror-candidates`);
  if (suggestions.error) return <p className="text-red-600">{suggestions.error}</p>;
  if (!suggestions.data) return <p className="text-xs text-slate-500">Looking...</p>;
  if (suggestions.data.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        Nothing on your other accounts going the same way within 7 days.
      </p>
    );
  }
  return (
    <div>
      <p className="text-xs text-slate-500">
        Pick the same purchase on another account (for a PayPal purchase, the card or bank charge
        that paid it). One of the two will be left out of totals.
      </p>
      <ul className="mt-1 divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
        {suggestions.data.map(({ transaction: c, exactAmount, namesAgree, daysApart }) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1">
              <strong>{c.accountName}</strong> · {c.merchant} ·{" "}
              {formatDay(c.authorizedDate ?? c.date)}
              <span className="block text-xs text-slate-500">
                {formatMinor(-c.amountMinor, c.currency)}
                {exactAmount ? " · same amount" : " · different amount"}
                {namesAgree ? " · same merchant" : ""}
                {` · ${daysApart} day${daysApart === 1 ? "" : "s"} apart`}
                {c.mirror ? ` · now linked with ${c.mirror.with.accountName}` : ""}
              </span>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onLink(c.id)}
              className={buttonClass}
            >
              Link
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
