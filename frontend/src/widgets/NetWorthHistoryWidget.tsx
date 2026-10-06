import { useMemo } from "react";
import { NetWorthChart } from "../components/history/NetWorthChart";
import { useApi } from "../hooks/useApi";
import { today } from "../lib/period";
import type { NetWorthHistory } from "../types/data";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/** `YYYY-MM-DD` this many days before `day`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export default defineWidget({
  id: "net-worth-history",
  title: "Net worth over time",
  description:
    "Net worth on the days balances were recorded, with gaps shown rather than filled in.",
  group: "Accounts",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  defaultEnabled: true,
  order: 15,
  defaultConfig: { range: "365", breakdown: false },
  configFields: [
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
    { key: "breakdown", label: "Show assets and debts as separate lines", type: "boolean" },
  ],
  Component: function NetWorthHistoryView({ config }) {
    const from = useMemo(() => daysBefore(today(), Number(config.range)), [config.range]);
    const { data, error, loading } = useApi<NetWorthHistory>(
      `/analytics/net-worth-history?from=${from}`,
    );
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.points.length === 0}
        emptyText="No balances recorded yet. A point is added each time an account syncs."
      >
        {data && <NetWorthChart history={data} breakdown={config.breakdown} />}
      </WidgetState>
    );
  },
});
