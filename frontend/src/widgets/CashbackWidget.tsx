import { useApi } from "../hooks/useApi";
import type { CashbackSummary } from "../lib/cashback";
import { formatRate } from "../lib/cashback";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import { periodField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "cashback",
  title: "Cashback earned",
  description:
    "What your credit cards have earned in cashback, from the rates you set on each card.",
  group: "Accounts",
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 4 },
  order: 36,
  defaultConfig: { period: "this-month" },
  configFields: [periodField],
  Component: function CashbackView({ config }) {
    const range = resolvePeriod(config.period);
    const { data, error, loading } = useApi<CashbackSummary>(
      `/cashback/summary?from=${range.from}&to=${range.to}`,
    );
    const rated = data?.cards.filter((c) => c.hasRates) ?? [];
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.cards.length === 0}
        emptyText="No credit cards yet."
      >
        {data && (
          <div className="space-y-3">
            <div>
              <div className="text-2xl font-semibold tabular-nums">
                {formatMinor(data.totalCashbackMinor, data.currency)}
              </div>
              <div className="text-xs text-slate-500">earned {range.label} (an estimate)</div>
            </div>
            {rated.length === 0 && (
              <p className="text-sm text-slate-500">
                Set each card&apos;s cashback rates on the Accounts page to track what it earns.
              </p>
            )}
            <ul className="space-y-2 text-sm">
              {rated.map((c) => (
                <li key={c.accountId}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.color ?? "#94a3b8" }}
                      />
                      <span className="truncate">{c.name}</span>
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatMinor(c.cashbackMinor, data.currency)}
                    </span>
                  </div>
                  {c.buckets.slice(0, 3).map((b) => (
                    <div
                      key={`${b.categoryId}-${b.label}`}
                      className="flex justify-between pl-4 text-xs text-slate-500"
                    >
                      <span>
                        {b.label} · {formatRate(b.rateBps)}
                      </span>
                      <span className="tabular-nums">
                        {formatMinor(b.cashbackMinor, data.currency)}
                      </span>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </WidgetState>
    );
  },
});
