import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { TransactionDetail } from "../components/transactions/TransactionDetail";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import { formatMinor } from "../lib/money";
import { useSyncFinishedCount } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import type { Account, Transaction, TransactionPage, TransactionSort } from "../types/api";

const PAGE_SIZE = 50;

interface Filters {
  q: string;
  accountId: string;
  category: string; // "" = all, "none" = uncategorized, or a category ID
  pending: string; // "" = all, "true", "false"
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { q: "", accountId: "", category: "", pending: "", from: "", to: "" };

const controlClass =
  "rounded border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800";

function AmountCell({ t }: { t: Transaction }) {
  // The data uses Plaid's convention (positive = money out); show it the way people read it:
  // spending as a minus, money in as a plus.
  const shown = -t.amountMinor;
  return (
    <span
      className={`tabular-nums ${shown > 0 ? "font-medium text-green-700 dark:text-green-400" : ""}`}
    >
      {shown > 0 ? "+" : ""}
      {formatMinor(shown, t.currency)}
    </span>
  );
}

/** A column header that sorts when clicked and shows the current direction. */
function SortHeader({
  label,
  ascending,
  descending,
  sort,
  onSort,
  align,
}: {
  label: string;
  ascending: TransactionSort;
  descending: TransactionSort;
  sort: TransactionSort;
  onSort: (sort: TransactionSort) => void;
  align?: "right";
}) {
  const active = sort === ascending || sort === descending;
  return (
    <th
      aria-sort={active ? (sort === ascending ? "ascending" : "descending") : "none"}
      className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : ""}`}
    >
      <button
        type="button"
        onClick={() => onSort(sort === descending ? ascending : descending)}
        className="uppercase hover:text-slate-900 dark:hover:text-white"
      >
        {label}
        {active ? (sort === ascending ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}

export function TransactionsPage() {
  const [data, setData] = useState<TransactionPage | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const { categories } = useCategories();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<TransactionSort>("date_desc");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const synced = useSyncFinishedCount();

  useEffect(() => {
    api<Account[]>("/accounts")
      .then(setAccounts)
      .catch(() => undefined);
  }, [synced]);

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() }));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort });
    if (filters.q) params.set("q", filters.q);
    if (filters.accountId) params.set("accountId", filters.accountId);
    if (filters.category) params.set("category", filters.category);
    if (filters.pending) params.set("pending", filters.pending);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    api<TransactionPage>(`/transactions?${params}`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, "Could not load transactions."));
      });
    return () => {
      cancelled = true;
    };
  }, [page, sort, filters, synced]);

  const options = useMemo(() => categoryOptions(categories ?? []), [categories]);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = Object.values(filters).some((v) => v !== "") || search !== "";

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]): void {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  function replaceRow(updated: Transaction): void {
    setData((d) => d && { ...d, items: d.items.map((t) => (t.id === updated.id ? updated : t)) });
  }

  async function quickCategory(t: Transaction, value: string): Promise<void> {
    try {
      replaceRow(
        await api<Transaction>(`/transactions/${t.id}`, {
          method: "PATCH",
          body: JSON.stringify({ categoryId: value === "" ? null : Number(value) }),
        }),
      );
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Could not change the category."));
    }
  }

  return (
    <section className="max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Transactions</h1>
        {data && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {data.total} {data.total === 1 ? "transaction" : "transactions"}
            {filtered ? " match your filters" : ""}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2" role="search">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search merchant, recipient, category, notes"
          aria-label="Search transactions"
          className={`${controlClass} w-72`}
        />
        <select
          aria-label="Account"
          value={filters.accountId}
          onChange={(e) => setFilter("accountId", e.target.value)}
          className={controlClass}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Category"
          value={filters.category}
          onChange={(e) => setFilter("category", e.target.value)}
          className={controlClass}
        >
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={filters.pending}
          onChange={(e) => setFilter("pending", e.target.value)}
          className={controlClass}
        >
          <option value="">Pending and posted</option>
          <option value="true">Pending only</option>
          <option value="false">Posted only</option>
        </select>
        <label className="text-xs text-slate-500">
          From
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilter("from", e.target.value)}
            className={`${controlClass} ml-1`}
          />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilter("to", e.target.value)}
            className={`${controlClass} ml-1`}
          />
        </label>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setFilters(NO_FILTERS);
              setPage(1);
            }}
            className="rounded px-2 py-2 text-sm text-blue-600 underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="flex items-start justify-between gap-3 rounded-md bg-blue-100 px-3 py-2 text-sm text-blue-900"
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            className="font-bold"
          >
            ×
          </button>
        </p>
      )}

      {data && data.items.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-600">
          {filtered
            ? "No transactions match those filters."
            : "No transactions yet. Connect an account on the Accounts page; transactions appear after the first sync."}
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <SortHeader
                  label="Date"
                  ascending="date_asc"
                  descending="date_desc"
                  sort={sort}
                  onSort={setSort}
                />
                <SortHeader
                  label="Merchant"
                  ascending="merchant_asc"
                  descending="merchant_desc"
                  sort={sort}
                  onSort={setSort}
                />
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Recipient</th>
                <SortHeader
                  label="Amount"
                  ascending="amount_asc"
                  descending="amount_desc"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDay(t.date)}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setSelected(t)}
                      title="Open details and edit"
                      className="text-left font-medium hover:underline"
                    >
                      {t.merchant}
                    </button>
                    {t.pending && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                        Pending
                      </span>
                    )}
                    {t.notes && (
                      <span
                        title={t.notes}
                        aria-label="Has a note"
                        className="ml-2 text-xs text-slate-400"
                      >
                        ✎
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block h-2.5 w-2.5 rounded-full"
                      style={{
                        backgroundColor: t.category?.color ?? "transparent",
                        border: t.category?.color ? undefined : "1px solid #94a3b8",
                      }}
                    />
                    <select
                      aria-label={`Category for ${t.merchant}`}
                      value={t.category ? String(t.category.id) : ""}
                      title={
                        t.category
                          ? t.category.source === "manual"
                            ? "Chosen by you"
                            : `Set by rule: ${t.category.ruleName ?? ""}`
                          : "No category"
                      }
                      onChange={(e) => void quickCategory(t, e.target.value)}
                      className="max-w-44 rounded border border-transparent bg-transparent py-1 text-sm hover:border-slate-300 dark:hover:border-slate-600"
                    >
                      <option value="">Uncategorized</option>
                      {/* Keep an archived category visible so the row still reads correctly. */}
                      {t.category && !options.some((o) => o.id === t.category!.id) && (
                        <option value={t.category.id}>{t.category.name} (archived)</option>
                      )}
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
                    />
                    {t.accountName}
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                    {t.recipient ?? ""}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <AmountCell t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-md border border-slate-300 px-3 py-2 disabled:opacity-50 dark:border-slate-600"
          >
            Previous
          </button>
          <span className="text-slate-500">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page >= pages}
            className="rounded-md border border-slate-300 px-3 py-2 disabled:opacity-50 dark:border-slate-600"
          >
            Next
          </button>
        </div>
      )}

      {selected && (
        <TransactionDetail
          transaction={selected}
          categories={categories ?? []}
          onClose={() => setSelected(null)}
          onSaved={(updated, rule) => {
            replaceRow(updated);
            setSelected(null);
            if (rule) {
              setNotice(
                `Rule “${rule.name}” created. ${rule.changed} transaction${rule.changed === 1 ? "" : "s"} recategorized.`,
              );
              // Reload the list so every recategorized row shows its new category.
              setFilters((f) => ({ ...f }));
            }
          }}
        />
      )}
    </section>
  );
}
