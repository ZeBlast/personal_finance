import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { timeAgo } from "../lib/time";
import type { Overview } from "../types/analytics";
import { Stat, WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "net-worth",
  title: "Net worth",
  description: "What you own minus what you owe, from your current account balances.",
  group: "Accounts",
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 2, h: 2 },
  order: 10,
  singleton: true,
  Component: function NetWorth({ size }) {
    // A headline tile (two rows tall) shows the figure and the split, without the notes.
    const compact = size.h <= 2;
    const { data, error, loading } = useApi<Overview>("/analytics/overview");
    const o = data;
    const total = o ? o.assetsMinor + o.liabilitiesMinor : 0;
    const coverage = o?.coverage;

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={o !== null && coverage?.accountsCounted === 0}
        emptyText="No account balances yet. Connect an account on the Accounts page."
      >
        {o && coverage && (
          <div className={compact ? "flex h-full flex-col justify-center gap-1" : "space-y-3"}>
            <Stat
              label="Net worth"
              value={formatMinor(o.netWorthMinor, o.currency)}
              tone={o.netWorthMinor < 0 ? "bad" : undefined}
            />
            <div>
              <div
                className="flex h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"
                aria-hidden="true"
              >
                <div
                  className="bg-green-600"
                  style={{ width: `${total > 0 ? (o.assetsMinor / total) * 100 : 0}%` }}
                />
                <div
                  className="bg-red-600"
                  style={{ width: `${total > 0 ? (o.liabilitiesMinor / total) * 100 : 0}%` }}
                />
              </div>
              <div className={`flex justify-between ${compact ? "mt-1 text-xs" : "mt-2 text-sm"}`}>
                <span>
                  <span className="text-slate-500">Assets </span>
                  <span className="tabular-nums">{formatMinor(o.assetsMinor, o.currency)}</span>
                </span>
                <span>
                  <span className="text-slate-500">Debts </span>
                  <span className="tabular-nums">
                    {formatMinor(o.liabilitiesMinor, o.currency)}
                  </span>
                </span>
              </div>
            </div>
            <p className={compact ? "sr-only" : "text-xs text-slate-500 dark:text-slate-400"}>
              Based on {coverage.accountsCounted} account{coverage.accountsCounted === 1 ? "" : "s"}
              {coverage.newestBalanceAt ? `, updated ${timeAgo(coverage.newestBalanceAt)}` : ""}.
              {coverage.accountsWithoutBalance > 0
                ? ` ${coverage.accountsWithoutBalance} without a balance yet are not counted.`
                : ""}
              {coverage.accountsOtherCurrency > 0
                ? ` ${coverage.accountsOtherCurrency} in another currency are not counted.`
                : ""}
            </p>
          </div>
        )}
      </WidgetState>
    );
  },
});
