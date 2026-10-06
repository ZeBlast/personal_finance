import { useApi } from "../hooks/useApi";
import { formatMinor, formatQuantity } from "../lib/money";
import type { HoldingRow } from "../types/investments";
import { countField, investmentAccountField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "holdings",
  title: "Holdings",
  description: "Your largest investment positions with their value and, where known, their gain.",
  group: "Accounts",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 3 },
  order: 27,
  defaultConfig: { accountId: "", topN: 8, combine: true },
  configFields: [
    investmentAccountField,
    countField("topN", "Holdings to show", 3, 25),
    { key: "combine", label: "Combine the same fund across accounts", type: "boolean" },
  ],
  Component: function Holdings({ config }) {
    const params = [
      config.combine ? "combine=1" : "",
      config.accountId ? `accountId=${config.accountId}` : "",
    ]
      .filter(Boolean)
      .join("&");
    const { data, error, loading } = useApi<HoldingRow[]>(
      `/investments/holdings${params ? `?${params}` : ""}`,
    );
    const rows = (data ?? []).slice(0, config.topN);
    const money = (n: number) => formatMinor(n, "USD");

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.length === 0}
        emptyText="No holdings yet. Sync a connected account, or enter holdings by hand on the Investments page."
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th scope="col" className="pb-1 font-medium">
                Holding
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Value
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Gain
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.key} className="border-t border-slate-100 dark:border-slate-700">
                <td className="max-w-0 py-1 pr-2">
                  <div className="truncate" title={h.name}>
                    {h.symbol ?? h.name}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {formatQuantity(h.quantity)} · {h.assetClass}
                    {h.accountName ? ` · ${h.accountName}` : ""}
                  </div>
                </td>
                <td className="py-1 text-right tabular-nums">{money(h.valueMinor)}</td>
                <td className="py-1 text-right tabular-nums">
                  {h.gainMinor === null ? (
                    <span className="text-slate-400" title="Cost basis unknown">
                      —
                    </span>
                  ) : (
                    <span
                      className={
                        h.gainMinor >= 0
                          ? "text-green-700 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      }
                    >
                      {h.gainMinor >= 0 ? "+" : "−"}
                      {money(Math.abs(h.gainMinor))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </WidgetState>
    );
  },
});
