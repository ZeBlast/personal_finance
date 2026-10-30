import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Transaction } from "../../types/api";

interface Suggestion {
  transaction: Transaction;
  namesAgree: boolean;
  /** The refund is exactly the charge, or exactly what is left of it. */
  exactAmount: boolean;
  /** Days from the charge to the refund. */
  daysBefore: number;
  /** For a suggested charge: what is left of it to give back. */
  leftMinor: number | null;
}

interface Suggestions {
  suggestions: Suggestion[];
  more: boolean;
  range: "recent" | "all";
}

const buttonClass = "rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600";

/** How far apart a charge and its refund are, said from the side being looked at. */
export function dayGap(daysBefore: number, fromRefund: boolean): string {
  if (daysBefore === 0) return "same day";
  const n = Math.abs(daysBefore);
  const days = `${n} day${n === 1 ? "" : "s"}`;
  // From a refund, a charge is usually before it; from a charge, its refund after.
  const before = fromRefund ? daysBefore > 0 : daysBefore < 0;
  return `${days} ${before ? "before" : "after"}`;
}

/** The search's address: the same order every time. */
export function candidatesPath(id: number, q: string, all: boolean, limit: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (all) params.set("all", "true");
  params.set("limit", String(limit));
  return `/transactions/${id}/refund-candidates?${params.toString()}`;
}

/**
 * For money coming back: the charge it refunds. Linked, the refund counts against that charge in
 * every total (its month, its category) instead of as money in. For a charge: what has been
 * refunded of it, and finding a refund that came back for it.
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

  /** Links (or with null unlinks) `refundId` with a charge, then shows this transaction again. */
  async function link(refundId: number, originalId: number | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Transaction>(`/transactions/${refundId}/refund-of`, {
        method: "PUT",
        body: JSON.stringify({ originalId }),
      });
      setChoosing(false);
      onChanged(refundId === t.id ? updated : await api<Transaction>(`/transactions/${t.id}`));
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

  // A charge: what has come back of it, and finding more.
  if (t.amountMinor > 0) {
    // A transfer is not a purchase, and a pending charge is replaced once it posts.
    if (t.isTransfer || t.pending) return null;
    const left = t.amountMinor - t.refundedMinor;
    return (
      <div className="text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">Refunds</p>
          {left > 0 && (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setChoosing((v) => !v)}
            >
              {choosing ? "Cancel" : "Link a refund..."}
            </button>
          )}
        </div>
        {t.refundedMinor > 0 && (
          <>
            <p>
              {formatMinor(t.refundedMinor, t.currency)} of {formatMinor(t.amountMinor, t.currency)}{" "}
              has been refunded. Totals count only what was kept.
            </p>
            <LinkedRefunds
              charge={t}
              busy={busy}
              onUnlink={(refundId) => void link(refundId, null)}
            />
          </>
        )}
        {choosing && (
          <Finder transaction={t} busy={busy} onPick={(refundId) => void link(refundId, t.id)} />
        )}
        {errorLine}
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
            onClick={() => void link(t.id, null)}
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
      {choosing && (
        <Finder
          transaction={t}
          busy={busy}
          onPick={(chargeId) => void link(t.id, chargeId)}
          onCancel={t.refundOf ? undefined : () => setChoosing(false)}
        />
      )}
      {errorLine}
    </div>
  );
}

/** The refunds linked to a charge, each of which can be unlinked. */
function LinkedRefunds({
  charge,
  busy,
  onUnlink,
}: {
  charge: Transaction;
  busy: boolean;
  onUnlink: (refundId: number) => void;
}) {
  const list = useApi<Transaction[]>(`/transactions/${charge.id}/refunds`);
  const { reload } = list;
  // Loaded again whenever what has been refunded changes (a refund linked or unlinked).
  const refunded = useRef(charge.refundedMinor);
  useEffect(() => {
    if (refunded.current === charge.refundedMinor) return;
    refunded.current = charge.refundedMinor;
    reload();
  }, [charge.refundedMinor, reload]);
  if (list.error) return <p className="text-red-600">{list.error}</p>;
  if (!list.data) return null;
  return (
    <ul className="mt-1 divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
      {list.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2 px-2 py-1">
          <span className="min-w-0 flex-1">
            <strong>{r.merchant}</strong> · {formatDay(r.authorizedDate ?? r.date)} ·{" "}
            {r.accountName}
            <span className="block text-xs text-slate-500">
              {formatMinor(-r.amountMinor, r.currency)} back
              {r.refundOf?.source === "auto" ? " · found by the app" : ""}
            </span>
          </span>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => onUnlink(r.id)}
            title="It counts as money in again, and the app won't link it automatically again."
          >
            Unlink
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Finding the other side: for a refund the purchase it gives back, for a purchase the money that
 * came back for it. The likeliest first; a search (words or an amount) looks through all history.
 */
function Finder({
  transaction: t,
  busy,
  onPick,
  onCancel,
}: {
  transaction: Transaction;
  busy: boolean;
  onPick: (id: number) => void;
  onCancel?: () => void;
}) {
  const fromRefund = t.amountMinor < 0;
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(10);
  const [data, setData] = useState<Suggestions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Wait for a pause in typing before searching; a new search starts from the top.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = search.trim();
      if (next !== q) {
        setQ(next);
        setLimit(10);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, q]);

  // The last results stay on screen while new ones load, so the list does not jump.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<Suggestions>(candidatesPath(t.id, q, all, limit))
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, "Could not look for matches."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t.id, q, all, limit]);

  const shown = (data?.suggestions ?? []).filter((s) => s.transaction.id !== t.refundOf?.id);
  const searching = q !== "";

  let empty: string;
  if (searching) {
    // Say what can be linked, since a search finds only that.
    empty = fromRefund
      ? `No purchase matches "${q}". Only a purchase from before this refund, with at least ${formatMinor(-t.amountMinor, t.currency)} left to refund, can be linked.`
      : `Nothing that came back matches "${q}". Only money in after this purchase, and no more than the ${formatMinor(t.amountMinor - t.refundedMinor, t.currency)} not yet refunded, can be linked.`;
  } else if (data?.range === "all") {
    empty = fromRefund
      ? "No purchase with at least this much left to refund."
      : "No money came back that could be this purchase's refund.";
  } else {
    empty = fromRefund
      ? "No purchase in the 6 months before it with at least this much left to refund."
      : "No money came back in the 6 months after it that could be this purchase's refund.";
  }

  return (
    <div className="mt-1 space-y-1">
      <p className="text-xs text-slate-500">
        {fromRefund
          ? "Pick the purchase this money gives back."
          : "Pick the money that came back for this purchase."}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.stopPropagation();
              setSearch("");
            }
          }}
          aria-label={fromRefund ? "Search purchases" : "Search money that came back"}
          placeholder="Merchant, account, category or amount"
          title="Search by merchant, account, category or amount (49.99, or 49 for $49.00 to $49.99)"
          maxLength={100}
          autoFocus
          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
        />
        {onCancel && (
          <button type="button" className={buttonClass} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {searching && <p className="text-xs text-slate-500">Searching all of your history.</p>}
      {error && <p className="text-red-600">{error}</p>}
      {!data && !error && <p className="text-xs text-slate-500">Looking...</p>}
      {data && shown.length === 0 && <p className="text-xs text-slate-500">{empty}</p>}
      {shown.length > 0 && (
        <ul
          aria-busy={loading}
          className={`max-h-80 divide-y divide-slate-200 overflow-y-auto rounded border border-slate-200 dark:divide-slate-700 dark:border-slate-700 ${loading ? "opacity-60" : ""}`}
        >
          {shown.map((s) => (
            <SuggestionRow
              key={s.transaction.id}
              suggestion={s}
              fromRefund={fromRefund}
              busy={busy}
              onPick={() => onPick(s.transaction.id)}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {data?.more && (
          <button
            type="button"
            className={buttonClass}
            disabled={loading}
            onClick={() => setLimit((n) => Math.min(n + 10, 100))}
          >
            Show more
          </button>
        )}
        {data?.range === "recent" && !searching && (
          <button
            type="button"
            className={buttonClass}
            disabled={loading}
            onClick={() => {
              setAll(true);
              setLimit(10);
            }}
          >
            {fromRefund ? "Look further back than 6 months" : "Look later than 6 months"}
          </button>
        )}
      </div>
    </div>
  );
}

function SuggestionRow({
  suggestion: { transaction: c, namesAgree, exactAmount, daysBefore, leftMinor },
  fromRefund,
  busy,
  onPick,
}: {
  suggestion: Suggestion;
  fromRefund: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  const amount = Math.abs(c.amountMinor);
  // The bank's own words help tell two purchases at one merchant apart.
  const bankText = c.name.trim() !== c.merchant.trim() ? c.name : null;
  const details = [
    formatMinor(amount, c.currency),
    leftMinor !== null && leftMinor < amount
      ? `${formatMinor(leftMinor, c.currency)} left to refund`
      : null,
    c.category?.name ?? null,
    exactAmount ? "same amount" : null,
    namesAgree ? "same merchant" : null,
    dayGap(daysBefore, fromRefund),
  ].filter((d): d is string => d !== null);
  return (
    <li className="flex flex-wrap items-center gap-2 px-2 py-1">
      <span className="min-w-0 flex-1">
        <strong>{c.merchant}</strong> · {formatDay(c.authorizedDate ?? c.date)} · {c.accountName}
        {namesAgree && exactAmount && (
          <span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
            Likely
          </span>
        )}
        <span className="block text-xs text-slate-500">{details.join(" · ")}</span>
        {bankText && (
          <span className="block truncate text-xs text-slate-400" title={bankText}>
            {bankText}
          </span>
        )}
      </span>
      <button type="button" className={buttonClass} disabled={busy} onClick={onPick}>
        Link
      </button>
    </li>
  );
}
