import { useMemo } from "react";
import { LineChart } from "../components/charts/LineChart";
import { colorAt } from "../components/charts/palette";
import { useApi } from "../hooks/useApi";
import { formatAxisMoney, formatMinor } from "../lib/money";
import { today } from "../lib/period";
import type { PortfolioHistory } from "../types/investments";
import { investmentAccountField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/** `YYYY-MM-DD` this many days before `day`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export default defineWidget({
  id: "portfolio-history",
  title: "Portfolio value over time",
  description:
    "The value of your investments on the days it was recorded (each sync or update by hand).",
  group: "Accounts",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  order: 28,
  defaultConfig: { accountId: "", range: "365", split: false },
  configFields: [
    investmentAccountField,
    {
      key: "range",
      label: "How far back",
      type: "select",
      options: [
        { value: "90", label: "3 months" },
        { value: "365", label: "12 months" },
        { value: "36500", label: "Everything" },
      ],
    },
    { key: "split", label: "Show each account separately", type: "boolean" },
  ],
  Component: function PortfolioHistoryView({ config }) {
    const from = useMemo(() => daysBefore(today(), Number(config.range)), [config.range]);
    const params = [`from=${from}`, config.accountId ? `accountId=${config.accountId}` : ""]
      .filter(Boolean)
      .join("&");
    const { data, error, loading } = useApi<PortfolioHistory>(`/investments/history?${params}`);
    const money = (n: number) => formatMinor(n, "USD");

    const series = config.split
      ? (data?.accounts ?? []).map((a, i) => ({
          key: String(a.accountId),
          label: a.name,
          color: a.color ?? colorAt(i),
          points: a.points.map((p) => ({ date: p.date, value: p.valueMinor })),
        }))
      : [
          {
            key: "total",
            label: "Total value",
            color: colorAt(0),
            points: (data?.total ?? []).map((p) => ({ date: p.date, value: p.valueMinor })),
          },
        ];

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.total.length === 0}
        emptyText="No history yet. A point is added each time your accounts sync or you update them."
      >
        <LineChart series={series} format={money} formatAxis={formatAxisMoney} />
        <p className="mt-1 text-xs text-slate-500">
          Dots are the days a value was recorded; nothing is estimated between them.
        </p>
      </WidgetState>
    );
  },
});
