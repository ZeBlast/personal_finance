import { BarList } from "../components/charts/BarList";
import { Donut } from "../components/charts/Donut";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import type { HoldingRow, PortfolioOverview } from "../types/investments";
import { countField, investmentAccountField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "portfolio-allocation",
  title: "Portfolio allocation",
  description: "How your investments are split: by asset class (stocks, bonds, ...) or by holding.",
  group: "Accounts",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  order: 26,
  defaultConfig: { accountId: "", by: "class", topN: 6 },
  configFields: [
    investmentAccountField,
    {
      key: "by",
      label: "Split by",
      type: "select",
      options: [
        { value: "class", label: "Asset class" },
        { value: "holding", label: "Holding (fund or stock)" },
      ],
    },
    countField("topN", "Holdings to show", 3, 15),
  ],
  Component: function PortfolioAllocation({ config }) {
    const query = config.accountId ? `accountId=${config.accountId}` : "";
    const byHolding = config.by === "holding";
    const overview = useApi<PortfolioOverview>(`/investments/overview${query ? `?${query}` : ""}`);
    const holdings = useApi<HoldingRow[]>(
      byHolding ? `/investments/holdings?combine=1${query ? `&${query}` : ""}` : null,
    );
    const money = (n: number) => formatMinor(n, overview.data?.currency ?? "USD");

    let slices: Array<{ key: string; label: string; value: number }>;
    if (byHolding) {
      const sorted = (holdings.data ?? []).filter((h) => h.valueMinor > 0);
      const rest = sorted.slice(config.topN).reduce((sum, h) => sum + h.valueMinor, 0);
      slices = [
        ...sorted
          .slice(0, config.topN)
          .map((h) => ({ key: h.key, label: h.symbol ?? h.name, value: h.valueMinor })),
        ...(rest > 0 ? [{ key: "rest", label: "Everything else", value: rest }] : []),
      ];
    } else {
      slices = (overview.data?.allocation ?? []).map((s) => ({
        key: s.assetClass,
        label: s.assetClass,
        value: s.valueMinor,
      }));
    }

    const loading = overview.loading || (byHolding && holdings.loading);
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    const accountTotal = overview.data?.totalValueMinor ?? 0;
    const unallocated = accountTotal - (overview.data?.holdingsValueMinor ?? 0);

    return (
      <WidgetState
        loading={loading}
        error={overview.error ?? holdings.error}
        empty={!loading && slices.length === 0}
        emptyText="No holdings to show yet."
      >
        {config.topN > 8 && byHolding ? (
          <BarList rows={slices} format={money} />
        ) : (
          <Donut
            slices={slices}
            format={money}
            center={
              <>
                <span className="text-xs text-slate-500">Holdings</span>
                <span className="text-sm font-semibold tabular-nums">{money(total)}</span>
              </>
            }
          />
        )}
        {unallocated > Math.max(100, accountTotal * 0.01) && (
          <p className="mt-2 text-xs text-slate-500">
            {money(unallocated)} of the account value is not broken down into holdings.
          </p>
        )}
      </WidgetState>
    );
  },
});
