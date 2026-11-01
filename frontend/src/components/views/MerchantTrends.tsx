import { useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { useApi } from "../../hooks/useApi";
import { categoryOptions, useCategories } from "../../hooks/useCategories";
import { formatMinor } from "../../lib/money";
import { monthLabel, today } from "../../lib/period";
import { merchantChange, sortMerchants } from "../../lib/views";
import { Select } from "../common/Select";
import { WidgetState } from "../../widgets/WidgetFrame";

export interface MerchantTrendsData {
  currency: string;
  months: string[];
  currentMonth: string;
  totalMinor: number;
  comparable: boolean;
  merchants: Array<{
    merchant: string;
    values: number[];
    currentMinor: number;
    totalMinor: number;
    sharePercent: number;
    recentAverageMinor: number;
    earlierAverageMinor: number;
  }>;
}

function MonthBars({
  values,
  months,
  money,
}: {
  values: number[];
  months: string[];
  money: (minor: number) => string;
}) {
  const top = Math.max(1, ...values);
  return (
    <svg width={72} height={22} aria-hidden="true" className="shrink-0">
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(2, (v / top) * 22) : 0;
        const w = 72 / values.length;
        return (
          <rect
            key={months[i]}
            x={i * w}
            y={22 - h}
            width={Math.max(1, w - 2)}
            height={h}
            rx={1}
            className={
              i === values.length - 1
                ? "fill-blue-600 dark:fill-blue-400"
                : "fill-slate-300 dark:fill-slate-600"
            }
          >
            <title>{`${monthLabel(months[i]!)}: ${money(v)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/**
 * Who has been taking the most, month by month, and who is growing. With a category chosen, shows
 * what share of that category each merchant takes.
 */
export function MerchantTrends({
  months = 6,
  limit = 15,
  controls = true,
  initialCategory = "",
}: {
  months?: number;
  limit?: number;
  controls?: boolean;
  initialCategory?: string;
}) {
  const [category, setCategory] = useState(initialCategory);
  const [sort, setSort] = useState<"biggest" | "growing">("biggest");
  const { categories } = useCategories();
  const query = new URLSearchParams({ months: String(months), today: today() });
  if (category) query.set("category", category);
  const { data, error, loading } = useApi<MerchantTrendsData>(`/reports/merchants?${query}`);
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
  const list = data ? sortMerchants(data.merchants, sort).slice(0, limit) : [];

  return (
    <div className="space-y-3">
      {controls && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            Category
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-600"
            >
              <option value="">All spending</option>
              {categoryOptions(categories ?? []).map((c) => (
                <option key={c.id} value={c.id} data-depth={c.depth}>
                  {c.label}
                </option>
              ))}
            </Select>
          </label>
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-600">
            {(["biggest", "growing"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sort === s}
                onClick={() => setSort(s)}
                className={`px-3 py-1 ${sort === s ? "bg-blue-600 text-white" : "hover:bg-slate-100 dark:hover:bg-slate-700"}`}
              >
                {s === "biggest" ? "Biggest" : "Growing fastest"}
              </button>
            ))}
          </div>
        </div>
      )}
      <WidgetState
        loading={loading && !data}
        error={error}
        empty={data !== null && data.merchants.length === 0}
        emptyText="No spending in these months."
      >
        {data && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 font-medium">Merchant</th>
                <th className="py-1 font-medium">
                  {monthLabel(data.months[0]!)} to {monthLabel(data.months.at(-1)!)}
                </th>
                <th className="py-1 text-right font-medium">Share</th>
                <th className="py-1 text-right font-medium">Total</th>
                <th className="py-1 text-right font-medium">A month, change</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const change = merchantChange(m);
                return (
                  <tr key={m.merchant} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="max-w-48 truncate py-1.5 pr-2" title={m.merchant}>
                      {m.merchant}
                    </td>
                    <td className="py-1.5 pr-2">
                      <MonthBars values={m.values} months={data.months} money={money} />
                    </td>
                    <td className="py-1.5 text-right text-slate-500 tabular-nums">
                      {m.sharePercent}%
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{money(m.totalMinor)}</td>
                    <td className="py-1.5 text-right whitespace-nowrap tabular-nums">
                      {!data.comparable ? (
                        <span className="text-slate-500">Not enough history</span>
                      ) : change === 0 ? (
                        <span className="text-slate-500">Steady</span>
                      ) : (
                        <span
                          className={`inline-flex items-center gap-1 ${change > 0 ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}
                        >
                          {change > 0 ? (
                            <TrendingUp aria-hidden="true" className="h-3.5 w-3.5" />
                          ) : (
                            <TrendingDown aria-hidden="true" className="h-3.5 w-3.5" />
                          )}
                          {change > 0 ? "+" : "−"}
                          {money(Math.abs(change))}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </WidgetState>
    </div>
  );
}
