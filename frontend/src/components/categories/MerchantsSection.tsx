import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { categoryOptions } from "../../hooks/useCategories";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { Category } from "../../types/api";

interface MerchantRow {
  key: string;
  merchant: string;
  transactionCount: number;
  lastDate: string;
  uncategorizedCount: number;
  categoryCount: number;
  assigned: { ruleId: number; categoryId: number; categoryName: string } | null;
}

interface MerchantList {
  total: number;
  rows: MerchantRow[];
}

interface AssignResult {
  merchant: string;
  changed: number;
  transactions: number;
}

const PAGE = 50;

const controlClass =
  "rounded border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800";

/** What the merchant's transactions look like, in a few words, when that is worth saying. */
export function merchantStatus(
  m: Pick<MerchantRow, "assigned" | "uncategorizedCount" | "categoryCount" | "transactionCount">,
): string | null {
  if (m.assigned) {
    // Assigned, yet some transactions differ: the user chose those by hand.
    const others = m.categoryCount > 1 || m.uncategorizedCount > 0;
    return others ? "some transactions have a different category you chose" : null;
  }
  if (m.uncategorizedCount === m.transactionCount) return "no category yet";
  if (m.categoryCount > 1) return "transactions are in different categories";
  if (m.uncategorizedCount > 0) return `${m.uncategorizedCount} without a category`;
  return null;
}

/**
 * Every merchant in the transactions, with a place to choose its category. Choosing one puts all of
 * the merchant's transactions, and its future ones, in that category.
 */
export function MerchantsSection({
  categories,
  onChanged,
}: {
  categories: Category[];
  /** Called after an assignment, so the rules list (which gains or changes a rule) can refresh. */
  onChanged: () => void;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState("all");
  const [limit, setLimit] = useState(PAGE);
  const [override, setOverride] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const options = categoryOptions(categories);

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQ(search.trim());
      setLimit(PAGE);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set("q", q);
  if (show !== "all") params.set("assigned", show);
  const { data, error, loading, reload } = useApi<MerchantList>(`/merchants?${params}`);

  async function assign(m: MerchantRow, value: string): Promise<void> {
    setBusyKey(m.key);
    setNotice(null);
    try {
      const result = await api<AssignResult>("/merchants/assignment", {
        method: "PUT",
        body: JSON.stringify({
          merchant: m.merchant,
          categoryId: value === "" ? null : Number(value),
          ...(override ? { overrideManual: true } : {}),
        }),
      });
      const name = options.find((o) => String(o.id) === value)?.name;
      setNotice({
        kind: "info",
        text:
          value === ""
            ? `${m.merchant} is no longer assigned to a category.`
            : `${m.merchant} → ${name ?? "category"}: ${result.changed} of ${result.transactions} transaction${result.transactions === 1 ? "" : "s"} updated. New ones will be categorized the same way.`,
      });
      reload();
      onChanged();
      announceDataChanged();
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not change that merchant.") });
    } finally {
      setBusyKey(null);
    }
  }

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-medium">Merchants</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Put a merchant in a category and every transaction there, now and in the future, goes in
          it too. Different spellings of the same place (such as “Chipotle” and “CHIPOTLE 2041”)
          count as one merchant. A category you chose on a single transaction is kept.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2" role="search">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search merchants"
          aria-label="Search merchants"
          className={`${controlClass} w-64`}
        />
        <select
          aria-label="Show merchants"
          value={show}
          onChange={(e) => {
            setShow(e.target.value);
            setLimit(PAGE);
          }}
          className={controlClass}
        >
          <option value="all">All merchants</option>
          <option value="unassigned">Not assigned to a category</option>
          <option value="assigned">Assigned to a category</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              Assigned to {o.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          Also replace categories I chose by hand
        </label>
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
              : "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
          }`}
        >
          {notice.text}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && rows.length === 0 && (
        <p className="text-sm text-slate-500">
          {q || show !== "all"
            ? "No merchants match."
            : "No merchants yet. They appear once there are transactions."}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-xs text-slate-600 uppercase dark:bg-slate-800 dark:text-slate-300">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Merchant
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Transactions
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Category
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {rows.map((m) => {
                const status = merchantStatus(m);
                return (
                  <tr key={m.key}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{m.merchant}</div>
                      <div className="text-xs text-slate-500">
                        last on {formatDay(m.lastDate)}
                        {status ? ` · ${status}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.transactionCount}</td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Category for ${m.merchant}`}
                        value={m.assigned ? String(m.assigned.categoryId) : ""}
                        disabled={busyKey === m.key}
                        onChange={(e) => void assign(m, e.target.value)}
                        className={`${controlClass} max-w-56`}
                      >
                        <option value="">Not assigned</option>
                        {m.assigned && !options.some((o) => o.id === m.assigned!.categoryId) && (
                          <option value={m.assigned.categoryId}>
                            {m.assigned.categoryName} (archived)
                          </option>
                        )}
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > rows.length && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>
            Showing {rows.length} of {data.total}
          </span>
          <button
            type="button"
            onClick={() => setLimit((l) => l + PAGE)}
            className="rounded-md border border-slate-300 px-3 py-2 text-slate-900 dark:border-slate-600 dark:text-slate-100"
          >
            Show more
          </button>
        </div>
      )}
    </div>
  );
}
