import { NetWorthSeriesChart } from "../components/history/NetWorthSeriesChart";
import { useApi } from "../hooks/useApi";
import { seriesPath } from "../lib/networthSeries";
import type { NetWorthSeries } from "../types/data";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "net-worth-history",
  title: "Net worth over time",
  description:
    "Net worth at the end of each day, week, or month, from recorded balances and transaction history.",
  group: "Accounts",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  order: 15,
  defaultConfig: { range: "365", granularity: "week", breakdown: false },
  configFields: [
    {
      key: "granularity",
      label: "One point per",
      type: "select",
      options: [
        { value: "day", label: "Day" },
        { value: "week", label: "Week" },
        { value: "month", label: "Month" },
      ],
    },
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
  Component: function NetWorthHistoryView({ config, size }) {
    const { data, error, loading } = useApi<NetWorthSeries>(
      seriesPath(config.granularity, Number(config.range)),
    );
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.points.length === 0}
        emptyText="No balances yet. Connect an account, or add one by hand, to see net worth over time."
        emptyAction={{ to: "/accounts", label: "Add an account" }}
      >
        {data && (
          <NetWorthSeriesChart
            series={data}
            breakdown={config.breakdown}
            // Rows are at least 60px; leave room for the title bar and the notes toggle.
            maxHeight={Math.max(120, size.h * 60 - 60)}
          />
        )}
      </WidgetState>
    );
  },
});
