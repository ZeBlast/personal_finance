import { NetworkGraph } from "../components/graph/NetworkGraph";
import { useApi } from "../hooks/useApi";
import type { GraphData } from "../lib/graph/model";
import { today } from "../lib/period";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

const daysBefore = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** The Network tab's graph of banks, accounts and where the money went, right on the dashboard. */
export default defineWidget({
  id: "network-graph",
  title: "Money network",
  description:
    "The Network tab's graph of banks, accounts, spending, income and transfers, to explore right on the dashboard.",
  group: "Activity",
  defaultSize: { w: 8, h: 8 },
  minSize: { w: 4, h: 4 },
  order: 450,
  defaultConfig: { days: "30" },
  configFields: [
    {
      key: "days",
      label: "Period",
      type: "select",
      options: [
        { value: "7", label: "The last week" },
        { value: "30", label: "The last 30 days" },
        { value: "90", label: "The last 90 days" },
        { value: "365", label: "The last year" },
      ],
    },
  ],
  Component: function MoneyNetwork({ config }) {
    const to = today();
    const from = daysBefore(to, Number(config.days) - 1);
    const { data, error, loading } = useApi<GraphData & { truncated: boolean }>(
      `/graph/transactions?from=${from}&to=${to}`,
    );
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.accounts.length === 0}
      >
        {data && (
          <div className="h-full min-h-0">
            <NetworkGraph data={data} fill />
          </div>
        )}
      </WidgetState>
    );
  },
});
