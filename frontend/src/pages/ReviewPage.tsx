import { useState } from "react";
import { api, errorMessage } from "../api/client";
import { AccountName } from "../components/common/AccountName";
import { buttonClass, primaryClass } from "../components/investments/styles";
import { useApi } from "../hooks/useApi";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import { CategorySelect } from "../components/common/CategorySelect";
import { TransactionDetail, useWideScreen } from "../components/transactions/TransactionDetail";
import { formatMinor } from "../lib/money";
import { announceDataChanged } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import type { Transaction } from "../types/api";
import type { DuplicatePair, ReviewQueue, ReviewReason } from "../types/planning";

const REASONS: Record<ReviewReason, string> = {
  uncategorized: "No category",
  new_merchant: "New merchant",
  unusual_amount: "Unusual amount",
  large: "Large",
  duplicate: "Possible duplicate",
};

/** Tidying up: recent transactions worth a look, and possible duplicates. */
export function ReviewPage() {
  // The transaction being looked at: beside the queue on a wide window, over it otherwise.
  const [inspecting, setInspecting] = useState<Transaction | null>(null);
  const wide = useWideScreen();
  const queue = useApi<ReviewQueue>("/review");
  const dupes = useApi<DuplicatePair[]>("/duplicates");
  const loose = useApi<{ items: Transaction[]; total: number }>("/review/uncategorized");
  const { categories } = useCategories();
  const categoryChoices = categoryOptions((categories ?? []).filter((c) => c.active));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(true);
    try {
      await work();
      setError(null);
      queue.reload();
      dupes.reload();
      loose.reload();
      announceDataChanged();
    } catch (e) {
      setError(errorMessage(e, failure));
    } finally {
      setBusy(false);
    }
  }
  const mark = (ids: number[]) =>
    run(
      () => api("/review/mark", { method: "POST", body: JSON.stringify({ ids, reviewed: true }) }),
      "Could not mark them reviewed.",
    );

  const items = queue.data?.items ?? [];
  return (
    <div className="flex items-start gap-4">
      <section className="max-w-5xl min-w-0 flex-1 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Review</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Recent transactions worth a look, and anything that may have come in twice.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              To review{queue.data ? ` (${items.length})` : ""}
            </h2>
            {items.length > 0 && (
              <button
                type="button"
                className={primaryClass}
                disabled={busy}
                onClick={() => void mark(items.map((i) => i.transaction.id))}
              >
                Mark all reviewed
              </button>
            )}
          </div>
          {queue.data && (
            <p className="text-xs text-slate-500">
              The last {queue.data.windowDays} days. Click one to see and fix its details here; mark
              it reviewed when it looks right.
            </p>
          )}
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {items.map(({ transaction: t, reasons }) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <button
                  type="button"
                  title="See and edit its details"
                  aria-pressed={inspecting?.id === t.id}
                  onClick={() => setInspecting(t)}
                  className={`min-w-0 flex-1 rounded text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${inspecting?.id === t.id ? "bg-blue-50 dark:bg-blue-950/50" : ""}`}
                >
                  <div className="font-medium hover:underline">
                    {t.merchant}{" "}
                    <span className="font-normal text-slate-500">
                      {formatDay(t.authorizedDate ?? t.date)} ·{" "}
                      <AccountName name={t.accountName} institutionName={t.institutionName} />
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {reasons.map((r) => (
                      <span
                        key={r}
                        className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
                      >
                        {REASONS[r]}
                      </span>
                    ))}
                    {t.category && (
                      <span className="text-xs text-slate-500">{t.category.name}</span>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-3">
                  <Amount t={t} />
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => void mark([t.id])}
                  >
                    Looks right
                  </button>
                </div>
              </li>
            ))}
            {queue.data && items.length === 0 && (
              <li className="px-3 py-4 text-sm text-slate-500">
                Nothing to review. All caught up.
              </li>
            )}
          </ul>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">
            Uncategorized{loose.data ? ` (${loose.data.total})` : ""}
          </h2>
          <p className="text-xs text-slate-500">
            Every transaction without a category, however old. Pick one to file it; it then counts
            in that category everywhere. Transfers between your own accounts need no category.
            {loose.data && loose.data.total > loose.data.items.length
              ? ` Showing the newest ${loose.data.items.length}.`
              : ""}
          </p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {(loose.data?.items ?? []).map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <button
                  type="button"
                  title="See and edit its details"
                  aria-pressed={inspecting?.id === t.id}
                  onClick={() => setInspecting(t)}
                  className={`min-w-0 flex-1 rounded text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${inspecting?.id === t.id ? "bg-blue-50 dark:bg-blue-950/50" : ""}`}
                >
                  <div className="font-medium hover:underline">{t.merchant}</div>
                  <div className="text-xs text-slate-500">
                    {formatDay(t.authorizedDate ?? t.date)} ·{" "}
                    <AccountName name={t.accountName} institutionName={t.institutionName} />
                  </div>
                </button>
                <Amount t={t} />
                <CategorySelect
                  aria-label={`Category for ${t.merchant}`}
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    void run(
                      () =>
                        api(`/transactions/${t.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ categoryId: Number(e.target.value) }),
                        }),
                      "Could not set the category.",
                    );
                  }}
                  className="w-52 rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
                >
                  <option value="">Choose a category...</option>
                  {categoryChoices.map((o) => (
                    <option key={o.id} value={o.id} data-depth={o.depth}>
                      {o.label}
                    </option>
                  ))}
                </CategorySelect>
              </li>
            ))}
            {loose.data && loose.data.items.length === 0 && (
              <li className="px-3 py-4 text-sm text-slate-500">Everything has a category.</li>
            )}
          </ul>
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-semibold">
            Possible duplicates{dupes.data ? ` (${dupes.data.length})` : ""}
          </h2>
          <p className="text-xs text-slate-500">
            The same amount on the same account a few days apart, usually one entered by hand and
            one from the bank. Delete the one you entered by hand, or say they are different.
          </p>
          {(dupes.data ?? []).map((pair) => (
            <div
              key={pair.key}
              className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {pair.transactions.map((t) => (
                  <div key={t.id} className="rounded bg-slate-50 p-2 text-sm dark:bg-slate-800">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{t.merchant}</span>
                      <Amount t={t} />
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatDay(t.authorizedDate ?? t.date)} · {t.accountName} ·{" "}
                      {t.source === "manual" ? "entered by hand" : "from the bank"}
                      {t.pending ? " · pending" : ""}
                    </div>
                    {t.source === "manual" && (
                      <button
                        type="button"
                        className={`${buttonClass} mt-1 text-red-700 dark:text-red-400`}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => api(`/transactions/${t.id}`, { method: "DELETE" }),
                            "Could not delete it.",
                          )
                        }
                      >
                        Delete this one
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        api("/duplicates/dismiss", {
                          method: "POST",
                          body: JSON.stringify({
                            a: pair.transactions[0].id,
                            b: pair.transactions[1].id,
                          }),
                        }),
                      "Could not save that.",
                    )
                  }
                >
                  Not duplicates
                </button>
              </div>
            </div>
          ))}
          {dupes.data && dupes.data.length === 0 && (
            <p className="text-sm text-slate-500">No possible duplicates.</p>
          )}
        </div>
      </section>
      {inspecting && (
        <TransactionDetail
          key={inspecting.id}
          transaction={inspecting}
          variant={wide ? "panel" : "modal"}
          categories={categories ?? []}
          onClose={() => setInspecting(null)}
          onSaved={(updated) => {
            setInspecting(wide ? updated : null);
            queue.reload();
            loose.reload();
            dupes.reload();
          }}
        />
      )}
    </div>
  );
}

function Amount({ t }: { t: Transaction }) {
  const shown = -t.amountMinor;
  return (
    <span className={`tabular-nums ${shown > 0 ? "text-green-700 dark:text-green-400" : ""}`}>
      {shown > 0 ? "+" : ""}
      {formatMinor(shown, t.currency)}
    </span>
  );
}
