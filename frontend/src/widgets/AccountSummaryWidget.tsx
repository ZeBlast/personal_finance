import { useMemo } from "react";
import { ColumnChart } from "../components/charts/ColumnChart";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import { formatDay } from "../lib/time";
import type { Summary } from "../types/analytics";
import type { Account, Transaction } from "../types/api";
import { accountField, periodField } from "./fields";
import { Stat, WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/**
 * One account at a glance: its balance (and how much of the limit a card uses), what went in and
 * out over the period, spending day by day, and its latest transactions.
 */
export default defineWidget({
  id: "account-summary",
  title: "Account summary",
  description:
    "One account at a glance: balance, limit used, money in and out over a period, daily spending and its latest transactions.",
  group: "Accounts",
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 3 },
  order: 430,
  defaultConfig: { accountId: "", period: "this-month", latest: true },
  configFields: [
    { ...accountField, label: "Account", help: "Choose the account to show." },
    periodField,
    { key: "latest", label: "Show its latest transactions", type: "boolean" },
  ],
  Component: function AccountSummary({ config, size }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const accounts = useApi<Account[]>("/accounts?includeHidden=1");
    const account = accounts.data?.find((a) => String(a.id) === config.accountId) ?? null;
    // Days for a month or less; longer periods in weeks, so the columns stay readable.
    const span = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000;
    const bucket = span > 35 ? "week" : "day";
    const days = useApi<Summary>(
      account
        ? summaryPath({
            from: period.from,
            to: period.to,
            groupBy: bucket,
            fill: true,
            accountId: config.accountId,
          })
        : null,
    );
    const latest = useApi<{ items: Transaction[] }>(
      account && config.latest ? `/transactions?accountId=${account.id}&pageSize=6` : null,
    );
    const money = (n: number | null) => formatMinor(n, account?.currency || "USD");

    if (!config.accountId) {
      return (
        <p className="text-sm text-slate-500">Choose an account in this widget&apos;s settings.</p>
      );
    }
    const credit = account?.type === "credit";
    const limit = account?.creditLimitMinor ?? null;
    const used = credit && limit ? (account.currentBalanceMinor ?? 0) / limit : null;
    const t = days.data?.totals;

    return (
      <WidgetState loading={accounts.loading || days.loading} error={accounts.error ?? days.error}>
        {account ? (
          <div className="flex h-full flex-col gap-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{account.name}</div>
                <div className="text-xs text-slate-500">
                  {account.institutionName ?? "Kept by hand"}
                  {account.mask ? ` · •••• ${account.mask}` : ""}
                </div>
              </div>
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: account.color ?? "#94a3b8" }}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat
                label={credit ? "Owed" : "Balance"}
                value={money(account.currentBalanceMinor)}
              />
              <Stat label={`Spent ${period.label}`} value={money(t?.spendingMinor ?? 0)} />
              <Stat
                label="Money in"
                value={money(t?.incomeMinor ?? 0)}
                note={`${t?.count ?? 0} transactions`}
              />
            </div>
            {used !== null && (
              <div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                  <div
                    className={`h-full rounded-full ${used > 0.5 ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.min(100, Math.max(0, used * 100))}%` }}
                  />
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {Math.round(used * 100)}% of the {money(limit)} limit used
                </div>
              </div>
            )}
            {size.h >= 4 && (days.data?.rows.length ?? 0) > 0 && (
              <div className="h-28 shrink-0 overflow-hidden">
                <ColumnChart
                  fit
                  series={[{ key: "spent", label: "Spent", color: account.color ?? "#ef4444" }]}
                  groups={days.data!.rows.map((r) => ({
                    key: r.key,
                    label:
                      bucket === "week"
                        ? `${Number(r.key.slice(5, 7))}/${Number(r.key.slice(8))}`
                        : String(Number(r.key.slice(8))),
                    values: [r.spendingMinor],
                  }))}
                  format={(n) => money(n)}
                />
              </div>
            )}
            {config.latest && (latest.data?.items.length ?? 0) > 0 && (
              <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-700">
                {latest.data!.items.slice(0, Math.max(2, Math.floor(size.h))).map((tx) => (
                  <li key={tx.id} className="flex justify-between gap-2 py-1">
                    <span className="truncate">
                      {tx.merchant}{" "}
                      <span className="text-slate-500">
                        {formatDay(tx.authorizedDate ?? tx.date)}
                      </span>
                    </span>
                    <span
                      className={`tabular-nums ${tx.amountMinor < 0 ? "text-green-700 dark:text-green-400" : ""}`}
                    >
                      {tx.amountMinor < 0 ? "+" : "−"}
                      {money(Math.abs(tx.amountMinor))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">That account is no longer here. Choose another.</p>
        )}
      </WidgetState>
    );
  },
});
