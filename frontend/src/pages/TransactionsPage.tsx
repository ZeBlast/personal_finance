import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { MerchantGroupsDialog } from "../components/transactions/MerchantGroupsDialog";
import { useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { ManualTransactionDialog } from "../components/transactions/ManualTransactionDialog";
import { TransactionDetail } from "../components/transactions/TransactionDetail";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import { AccountName } from "../components/common/AccountName";
import { accountLabel } from "../lib/accountLabel";
import { AmountCell, TransactionTags } from "../components/transactions/TransactionCells";
import { announceDataChanged, useSyncFinishedCount } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import type { Account, Transaction, TransactionPage, TransactionSort } from "../types/api";
import { CategorySelect } from "../components/common/CategorySelect";
import { SplitDialog } from "../components/transactions/SplitDialog";
import { Select } from "../components/common/Select";

const PAGE_SIZE = 50;

/** Several categories (`3,7,none`) as one short label: "Food, Fun and 1 more". Pure. */
export function categoryListLabel(
  value: string,
  options: Array<{ id: number; name: string }>,
): string {
  const names = value
    .split(",")
    .filter(Boolean)
    .map((v) =>
      v === "none" ? "Uncategorized" : (options.find((o) => String(o.id) === v)?.name ?? "?"),
    );
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

interface Filters {
  q: string;
  accountId: string;
  category: string; // "" = all, "none" = uncategorized, a category ID, or several ("3,7,none")
  direction: string; // "" = both, "in" = money in only, "out" = money out only
  pending: string; // "" = all, "true", "false"
  online: string; // "" = all, "true" (bought online), "false" (not online)
  transfer: string; // "" = all, "unmatched" = transfers with no other side
  institution: string; // "" = all, an institution's name, or "manual"
  from: string;
  to: string;
  dateBasis: string; // "" = transaction date, "posted" = the date it posted (as statements do)
}

const NO_FILTERS: Filters = {
  q: "",
  accountId: "",
  category: "",
  direction: "",
  pending: "",
  online: "",
  transfer: "",
  institution: "",
  from: "",
  to: "",
  dateBasis: "",
};

const controlClass =
  "rounded border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800";

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
      className={`px-2 py-2 font-medium ${align === "right" ? "text-right" : ""}`}
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
  const [sort, setSort] = useState<TransactionSort>("txdate_desc");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);
  /** Adding a transaction by hand ("new"), or editing one that was entered by hand. */
  const [manualDialog, setManualDialog] = useState<"new" | Transaction | null>(null);
  /** The transaction whose split is being edited. */
  const [splitting, setSplitting] = useState<Transaction | null>(null);
  const [reloads, setReloads] = useState(0);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const synced = useSyncFinishedCount();
  /** The row clicked last; double-clicking a row opens it. */
  const [highlight, setHighlight] = useState<number | null>(null);
  /** A row just brought into view from elsewhere (the network graph), which flashes for a moment. */
  const [flash, setFlash] = useState<number | null>(null);
  // Opening a transaction from elsewhere: `?focus=<id>&account=<id>`.
  const [searchParams, setSearchParams] = useSearchParams();
  const [focus, setFocus] = useState<{ id: number; accountId: string | null } | null>(() => {
    const id = Number(searchParams.get("focus"));
    return Number.isInteger(id) && id > 0 ? { id, accountId: searchParams.get("account") } : null;
  });
  const tableRef = useRef<HTMLDivElement>(null);

  // Links from elsewhere (search, the graph), also while already on this page:
  // `?focus=<id>&account=<id>` opens a transaction; `?account=<id>`, `?category=<id>`, and
  // `?from=<day>&to=<day>` filter.
  useEffect(() => {
    const focusId = Number(searchParams.get("focus"));
    const account = searchParams.get("account");
    const category = searchParams.get("category");
    const direction = searchParams.get("direction");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (Number.isInteger(focusId) && focusId > 0) {
      setFilters(NO_FILTERS);
      setSearch("");
      setFocus((f) => (f?.id === focusId ? f : { id: focusId, accountId: account }));
      return;
    }
    if (account || category || direction || from || to) {
      setFilters({
        ...NO_FILTERS,
        accountId: account ?? "",
        category: category ?? "",
        direction: direction === "in" || direction === "out" ? direction : "",
        from: from ?? "",
        to: to ?? "",
        dateBasis: searchParams.get("dateBasis") === "posted" ? "posted" : "",
      });
      setSearch("");
      setPage(1);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    api<Account[]>("/accounts")
      .then(setAccounts)
      .catch(() => undefined);
  }, [synced]);

  /** The search the list was last filtered by. */
  const searchedFor = useRef("");
  useEffect(() => {
    searchedFor.current = filters.q;
  }, [filters.q]);

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = search.trim();
      // Only a changed search goes back to the first page.
      if (q === searchedFor.current) return;
      setFilters((f) => ({ ...f, q }));
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort });
    if (focus) params.set("focus", String(focus.id));
    if (filters.q) params.set("q", filters.q);
    if (filters.accountId) params.set("accountId", filters.accountId);
    if (filters.category) params.set("category", filters.category);
    if (filters.direction) params.set("direction", filters.direction);
    if (filters.pending) params.set("pending", filters.pending);
    if (filters.online) params.set("online", filters.online);
    if (filters.transfer) params.set("transfer", filters.transfer);
    if (filters.institution) params.set("institution", filters.institution);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.dateBasis) params.set("dateBasis", filters.dateBasis);
    api<TransactionPage>(`/transactions?${params}`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
        if (focus) {
          if (result.items.some((t) => t.id === focus.id)) {
            // Found: stay on its page, and point it out.
            setFocus(null);
            setPage(result.page);
            setHighlight(focus.id);
            setFlash(focus.id);
            setSearchParams({}, { replace: true });
          } else if (focus.accountId && filters.accountId !== focus.accountId) {
            // Not in the full list (a gift card or hidden account): look in its own account.
            setFilters({ ...NO_FILTERS, accountId: focus.accountId });
            setSearch("");
          } else {
            setFocus(null);
            setSearchParams({}, { replace: true });
            setNotice("That transaction is not in this list.");
          }
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, "Could not load transactions."));
      });
    return () => {
      cancelled = true;
    };
  }, [page, sort, filters, synced, reloads, focus, setSearchParams]);

  // The flashed row scrolls into view, and stops flashing after a moment.
  useEffect(() => {
    if (flash === null) return;
    tableRef.current
      ?.querySelector(`[data-row="${flash}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(timer);
  }, [flash, data]);

  const open = (t: Transaction) => (t.source === "manual" ? setManualDialog(t) : setSelected(t));
  /** Clicking a row highlights it; double-clicking opens it (not on its own controls). */
  const onControl = (e: MouseEvent) =>
    (e.target as HTMLElement).closest("button, select, input, a, label") !== null;

  const options = useMemo(() => categoryOptions(categories ?? []), [categories]);
  const institutions = [
    ...new Set(accounts.map((a) => a.institutionName).filter((n): n is string => !!n)),
  ].sort();
  const handAccounts = accounts.filter(
    (a) => a.isManual && (a.type === "depository" || a.type === "credit"),
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = Object.values(filters).some((v) => v !== "") || search !== "";

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]): void {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  function replaceRow(updated: Transaction): void {
    setData((d) => d && { ...d, items: d.items.map((t) => (t.id === updated.id ? updated : t)) });
  }

  async function quickOnline(t: Transaction, online: boolean): Promise<void> {
    try {
      // Food & Drink purchases move between Food & Drink (online) and Dining Out (in person).
      replaceRow(
        await api<Transaction>(`/transactions/${t.id}`, {
          method: "PATCH",
          body: JSON.stringify({ online }),
        }),
      );
      setError(null);
      announceDataChanged();
    } catch (e) {
      setError(errorMessage(e, "Could not change whether it was bought online."));
    }
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
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          {data && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {data.total} {data.total === 1 ? "transaction" : "transactions"}
              {filtered ? " match your filters" : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setGroupsOpen(true)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
          >
            Merchant groups
          </button>
          <button
            type="button"
            onClick={() => setManualDialog("new")}
            disabled={handAccounts.length === 0}
            title={
              handAccounts.length === 0
                ? "Add a cash or other account by hand on the Accounts page first"
                : undefined
            }
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            Add transaction
          </button>
        </div>
      </div>
      {groupsOpen && (
        <MerchantGroupsDialog
          onChanged={announceDataChanged}
          onClose={() => setGroupsOpen(false)}
        />
      )}

      <div className="flex flex-wrap items-end gap-2" role="search">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search merchant, recipient, sender, category, notes"
          aria-label="Search transactions"
          className={`${controlClass} w-72`}
        />
        <Select
          aria-label="Account"
          value={filters.accountId}
          onChange={(e) => setFilter("accountId", e.target.value)}
          className={controlClass}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountLabel(a.name, a.institutionName)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Institution"
          value={filters.institution}
          onChange={(e) => setFilter("institution", e.target.value)}
          className={controlClass}
        >
          <option value="">All institutions</option>
          {institutions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {accounts.some((a) => !a.institutionName) && <option value="manual">Kept by hand</option>}
        </Select>
        <Select
          aria-label="Category"
          value={filters.category}
          onChange={(e) => setFilter("category", e.target.value)}
          className={controlClass}
        >
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {filters.category.includes(",") && (
            // Several categories, from a chart (Insights): kept until another is chosen.
            <option value={filters.category}>{categoryListLabel(filters.category, options)}</option>
          )}
          {options.map((o) => (
            <option key={o.id} value={o.id} data-depth={o.depth}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Money in or out"
          value={filters.direction}
          onChange={(e) => setFilter("direction", e.target.value)}
          className={controlClass}
        >
          <option value="">Money in and out</option>
          <option value="in">Money in only</option>
          <option value="out">Money out only</option>
        </Select>
        <Select
          aria-label="Status"
          value={filters.pending}
          onChange={(e) => setFilter("pending", e.target.value)}
          className={controlClass}
        >
          <option value="">Pending and posted</option>
          <option value="true">Pending only</option>
          <option value="false">Posted only</option>
        </Select>
        <Select
          aria-label="Online purchases"
          value={filters.online}
          onChange={(e) => setFilter("online", e.target.value)}
          className={controlClass}
        >
          <option value="">Online and not online</option>
          <option value="true">Online only</option>
          <option value="false">Not online</option>
        </Select>
        <Select
          aria-label="Transfers"
          value={filters.transfer}
          onChange={(e) => setFilter("transfer", e.target.value)}
          className={controlClass}
        >
          <option value="">All transactions</option>
          <option value="unmatched">Transfers missing the other side</option>
        </Select>
        <Select
          aria-label="Which date From and To use"
          value={filters.dateBasis}
          onChange={(e) => setFilter("dateBasis", e.target.value)}
          className={controlClass}
        >
          <option value="">By transaction date</option>
          <option value="posted">By posted date</option>
        </Select>
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
        <div
          ref={tableRef}
          className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700"
        >
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <SortHeader
                  label="Transaction date"
                  ascending="txdate_asc"
                  descending="txdate_desc"
                  sort={sort}
                  onSort={setSort}
                />
                <SortHeader
                  label="Posted"
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
                <th className="px-2 py-2 font-medium">Category</th>
                <th className="px-2 py-2 font-medium">Tags</th>
                <th className="w-px px-1 py-2 text-center font-medium" title="Bought online">
                  Online
                </th>
                <th className="px-2 py-2 font-medium">Account</th>
                <th className="px-2 py-2 font-medium">Recipient / sender</th>
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
                <tr
                  key={t.id}
                  data-row={t.id}
                  aria-selected={highlight === t.id}
                  onClick={(e) => {
                    if (!onControl(e)) setHighlight(t.id);
                  }}
                  onDoubleClick={(e) => {
                    if (onControl(e)) return;
                    setHighlight(t.id);
                    open(t);
                  }}
                  title={
                    t.beforeOtherHistory
                      ? "Older than the history of your other accounts, so what paid for it can't be matched. Click to select, double-click to edit"
                      : "Click to select, double-click to edit"
                  }
                  className={`cursor-default transition-colors duration-700 ${
                    t.beforeOtherHistory ? "opacity-50 " : ""
                  }${
                    flash === t.id
                      ? "bg-amber-200 dark:bg-amber-700/50"
                      : highlight === t.id
                        ? "bg-blue-50 dark:bg-blue-950/50"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  }`}
                >
                  <td className="px-2 py-2 whitespace-nowrap">
                    {formatDay(t.authorizedDate ?? t.date)}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">
                    {t.pending ? "Pending" : formatDay(t.date)}
                  </td>
                  <td className="max-w-56 min-w-32 px-2 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setHighlight(t.id);
                        open(t);
                      }}
                      title="Open details and edit"
                      className="text-left font-medium hover:underline"
                    >
                      {t.merchant}
                    </button>
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
                  <td className="px-2 py-2 whitespace-nowrap">
                    {t.splits.length > 0 && t.splitValid ? (
                      <button
                        type="button"
                        onClick={() => setSplitting(t)}
                        title="Split across categories. Click to change it."
                        className="flex max-w-40 flex-col items-start gap-0.5 rounded px-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        {t.splits.map((p) => (
                          <span key={p.id} className="flex items-center gap-1 text-xs">
                            <span
                              aria-hidden="true"
                              className="inline-block h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: p.categoryColor ?? "#94a3b8" }}
                            />
                            <span className="truncate">{p.categoryName ?? "Uncategorized"}</span>
                            <span className="text-slate-400 tabular-nums">
                              {(Math.abs(p.amountMinor) / 100).toFixed(2)}
                            </span>
                          </span>
                        ))}
                      </button>
                    ) : (
                      <span className="flex items-center gap-1">
                        <span
                          aria-hidden="true"
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: t.category?.color ?? "transparent",
                            border: t.category?.color ? undefined : "1px solid #94a3b8",
                          }}
                        />
                        <CategorySelect
                          shown={t.category?.name ?? "Uncategorized"}
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
                          className="w-36 rounded border border-transparent bg-transparent py-1 pr-6 pl-2 text-sm hover:border-slate-300 dark:hover:border-slate-600"
                        >
                          <option value="">Uncategorized</option>
                          {/* Keep an archived category visible so the row still reads correctly. */}
                          {t.category && !options.some((o) => o.id === t.category!.id) && (
                            <option value={t.category.id}>{t.category.name} (archived)</option>
                          )}
                          {options.map((o) => (
                            <option key={o.id} value={o.id} data-depth={o.depth}>
                              {o.label}
                            </option>
                          ))}
                        </CategorySelect>
                      </span>
                    )}
                  </td>
                  <td className="w-44 min-w-36 px-2 py-2">
                    <TransactionTags t={t} />
                  </td>
                  <td className="w-px px-1 py-2 text-center">
                    {/* The pencil sits on the box's corner without widening the column. */}
                    <span className="relative inline-block align-middle">
                      <input
                        type="checkbox"
                        checked={t.online}
                        onChange={(e) => void quickOnline(t, e.target.checked)}
                        aria-label={`Bought online: ${t.merchant}`}
                        title={
                          t.onlineEdited
                            ? "Changed by you. Click again to go back to the bank's answer."
                            : "From the bank's payment channel. Click to change it."
                        }
                        className="block h-4 w-4"
                      />
                      {t.onlineEdited && (
                        <span
                          className="absolute -top-2 -right-2 text-[10px] text-slate-400"
                          title={`Changed by you (the bank says ${t.providerOnline ? "online" : "not online"})`}
                        >
                          ✎
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="max-w-56 min-w-32 px-2 py-2">
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
                    />
                    <AccountName name={t.accountName} institutionName={t.institutionName} />
                  </td>
                  <td className="max-w-32 px-2 py-2 break-words text-slate-600 dark:text-slate-300">
                    {(t.amountMinor > 0 ? t.recipient : t.sender) ?? ""}
                  </td>
                  <td className="min-w-28 px-2 py-2 text-right whitespace-nowrap">
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

      {manualDialog && (
        <ManualTransactionDialog
          accounts={handAccounts}
          categories={categories ?? []}
          transaction={manualDialog === "new" ? undefined : manualDialog}
          onSaved={(message) => {
            setManualDialog(null);
            setNotice(message);
            setReloads((n) => n + 1);
            announceDataChanged();
          }}
          onClose={() => setManualDialog(null)}
          onSplit={
            manualDialog === "new"
              ? undefined
              : () => {
                  setSplitting(manualDialog);
                  setManualDialog(null);
                }
          }
        />
      )}
      {splitting && (
        <SplitDialog
          transaction={splitting}
          categories={categories ?? []}
          onClose={() => setSplitting(null)}
          onSaved={(updated) => {
            replaceRow(updated);
            setSplitting(null);
            setNotice(
              updated.splits.length > 0
                ? `${updated.merchant} is split across ${updated.splits.length} categories.`
                : `${updated.merchant} is no longer split.`,
            );
            announceDataChanged();
          }}
        />
      )}
      {selected && (
        <TransactionDetail
          transaction={selected}
          categories={categories ?? []}
          onClose={() => setSelected(null)}
          onSplit={() => {
            setSplitting(selected);
            setSelected(null);
          }}
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
