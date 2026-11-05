import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Transaction } from "../../types/api";
import { buttonClass, primaryClass } from "../common/styles";
import { Select } from "../common/Select";

const COUNTS = Array.from({ length: 23 }, (_, i) => i + 2);

/**
 * A purchase paid off in instalments (Pay in 4, Klarna): the purchase counts once, and the
 * repayments linked to it are left out of totals. On a repayment, says which purchase it pays off.
 */
export function InstalmentLink({
  transaction: t,
  onChanged,
}: {
  transaction: Transaction;
  onChanged: (updated: Transaction) => void;
}) {
  if (t.instalmentOfId !== null) return <Repayment transaction={t} onChanged={onChanged} />;
  if (t.amountMinor > 0 && !t.isTransfer) return <Purchase transaction={t} onChanged={onChanged} />;
  return null;
}

function Repayment({
  transaction: t,
  onChanged,
}: {
  transaction: Transaction;
  onChanged: (updated: Transaction) => void;
}) {
  const purchase = useApi<Transaction>(`/transactions/${t.instalmentOfId}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onChanged(
        await api<Transaction>(`/transactions/${t.id}/instalment-of`, {
          method: "PUT",
          body: JSON.stringify({ purchaseId: null }),
        }),
      );
    } catch (e) {
      setError(errorMessage(e, "Could not unlink this."));
    } finally {
      setBusy(false);
    }
  }

  const p = purchase.data;
  return (
    <div className="text-sm">
      <p className="block text-sm font-medium">Paid in instalments</p>
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {p ? (
            <>
              Pays off <strong>{p.merchant}</strong> from {formatDay(p.authorizedDate ?? p.date)}{" "}
              (counted once, at the purchase).
            </>
          ) : (
            "Pays off a purchase made in instalments (counted once, at the purchase)."
          )}
        </span>
        <button type="button" disabled={busy} onClick={() => void unlink()} className={buttonClass}>
          {busy ? "Unlinking..." : "Unlink"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function Purchase({
  transaction: t,
  onChanged,
}: {
  transaction: Transaction;
  onChanged: (updated: Transaction) => void;
}) {
  const plan = t.instalmentPlan;
  const [open, setOpen] = useState(false);
  if (!plan && !open) {
    return (
      <div className="text-sm">
        <button type="button" onClick={() => setOpen(true)} className={buttonClass}>
          Paid in instalments...
        </button>
      </div>
    );
  }
  return <Plan transaction={t} onChanged={onChanged} onClose={() => setOpen(false)} />;
}

function Plan({
  transaction: t,
  onChanged,
  onClose,
}: {
  transaction: Transaction;
  onChanged: (updated: Transaction) => void;
  onClose: () => void;
}) {
  const plan = t.instalmentPlan;
  const [count, setCount] = useState(String(plan?.instalments ?? 4));
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useApi<Transaction[]>(
    plan ? `/transactions/${t.id}/instalment-candidates` : null,
  );

  async function run(work: () => Promise<Transaction | null>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await work();
      if (updated) onChanged(updated);
      else onClose();
    } catch (e) {
      setError(errorMessage(e, "Could not change this."));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(() =>
      api<Transaction>(`/transactions/${t.id}/instalments`, {
        method: "PUT",
        body: JSON.stringify({ instalments: Number(count) }),
      }),
    );
  const stop = () =>
    run(async () => {
      await api(`/transactions/${t.id}/instalments`, { method: "DELETE" });
      onClose();
      return api<Transaction>(`/transactions/${t.id}`);
    });
  async function link(): Promise<void> {
    setBusy(true);
    setError(null);
    let failure: string | null = null;
    try {
      for (const id of picked) {
        await api<Transaction>(`/transactions/${id}/instalment-of`, {
          method: "PUT",
          body: JSON.stringify({ purchaseId: t.id }),
        });
      }
    } catch (e) {
      failure = errorMessage(e, "Could not link these.");
    }
    try {
      // Whatever was linked before a refusal still counts, so show the purchase as it now is.
      onChanged(await api<Transaction>(`/transactions/${t.id}`));
      setPicked(new Set());
      candidates.reload();
    } catch (e) {
      failure ??= errorMessage(e, "Could not reload this.");
    }
    setError(failure);
    setBusy(false);
  }
  const toggle = (id: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="space-y-2 text-sm">
      <p className="block text-sm font-medium">Paid in instalments</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`instalments-${t.id}`}>Paid in</label>
        <Select
          id={`instalments-${t.id}`}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800"
        >
          {COUNTS.map((n) => (
            <option key={n} value={n}>
              {n} payments
            </option>
          ))}
        </Select>
        {(!plan || String(plan.instalments) !== count) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className={primaryClass}
          >
            {plan ? "Save" : "Start"}
          </button>
        )}
        {plan ? (
          <button type="button" disabled={busy} onClick={() => void stop()} className={buttonClass}>
            Stop treating as instalments
          </button>
        ) : (
          <button type="button" onClick={onClose} className={buttonClass}>
            Cancel
          </button>
        )}
      </div>
      {plan && (
        <>
          <p className="text-xs text-slate-500">
            {plan.repaymentCount === 0
              ? "No payments linked yet."
              : `${plan.repaymentCount} linked, ${formatMinor(plan.paidMinor, t.currency)} of ${formatMinor(t.amountMinor, t.currency)} paid.`}{" "}
            Linked payments are left out of totals; the purchase counts once. Leave a fee or
            interest charge unlinked so it still counts.
          </p>
          {candidates.error && <p className="text-red-600">{candidates.error}</p>}
          {candidates.data?.length === 0 && (
            <p className="text-xs text-slate-500">
              No payments of about{" "}
              {formatMinor(Math.round(t.amountMinor / plan.instalments), t.currency)} found in the
              next 6 months.
            </p>
          )}
          {candidates.data && candidates.data.length > 0 && (
            <>
              <ul className="divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
                {candidates.data.map((c) => (
                  <li key={c.id} className="px-2 py-1">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={picked.has(c.id)}
                        onChange={() => toggle(c.id)}
                      />
                      <span className="min-w-0 flex-1">
                        {c.merchant} · {formatDay(c.authorizedDate ?? c.date)}
                        <span className="block text-xs text-slate-500">
                          {c.accountName} · {formatMinor(c.amountMinor, c.currency)}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy || picked.size === 0}
                onClick={() => void link()}
                className={primaryClass}
              >
                {busy ? "Linking..." : "Link"}
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
