import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import type { TransactionPage } from "../types/api";
import { accountField, countField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "recent-transactions",
  title: "Recent transactions",
  description: "The latest transactions, newest first.",
  group: "Activity",
  defaultSize: { w: 6, h: 7 },
  minSize: { w: 3, h: 3 },
  defaultEnabled: true,
  order: 100,
  defaultConfig: { count: 8, accountId: "" },
  configFields: [countField("count", "Transactions to show", 3, 25), accountField],
  Component: function RecentTransactions({ config }) {
    const query = new URLSearchParams({ pageSize: String(config.count), sort: "txdate_desc" });
    if (config.accountId) query.set("accountId", config.accountId);
    const { data, error, loading } = useApi<TransactionPage>(`/transactions?${query}`);

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.items.length === 0}
        emptyText="No transactions yet. They appear after the first sync."
      >
        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {data?.items.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{t.merchant}</span>
                  {t.pending && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 text-xs text-amber-900">
                      Pending
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 text-xs text-slate-500">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
                  />
                  {formatDay(t.date)} · {t.accountName}
                  {t.category ? ` · ${t.category.name}` : ""}
                  {t.recipient ? ` · ${t.recipient}` : ""}
                </div>
              </div>
              <span
                className={`shrink-0 tabular-nums ${t.amountMinor < 0 ? "font-medium text-green-700 dark:text-green-400" : ""}`}
              >
                {t.amountMinor < 0 ? "+" : ""}
                {formatMinor(-t.amountMinor, t.currency)}
              </span>
            </li>
          ))}
        </ul>
      </WidgetState>
    );
  },
});
