import { useMemo } from "react";
import { UtilizationChart } from "../components/insights/UtilizationChart";
import { useApi } from "../hooks/useApi";
import { today } from "../lib/period";
import type { UtilizationHistory } from "../types/insights";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/** `YYYY-MM-DD` this many days before `day`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export default defineWidget({
  id: "credit-utilization",
  title: "Credit utilization",
  description:
    "How much of each card's limit is in use, and how that has changed on the days it was recorded.",
  group: "Accounts",
  defaultSize: { w: 6, h: 7 },
  minSize: { w: 4, h: 4 },
  order: 35,
  defaultConfig: { range: "365", perCard: false },
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
    { key: "perCard", label: "Draw each card as its own line", type: "boolean" },
  ],
  Component: function CreditUtilization({ config }) {
    const from = useMemo(() => daysBefore(today(), Number(config.range)), [config.range]);
    const { data, error, loading } = useApi<UtilizationHistory>(
      `/insights/credit-utilization?from=${from}`,
    );
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.cards.length === 0}
        emptyText="No credit cards connected."
      >
        {data && <UtilizationChart history={data} perCard={config.perCard} />}
      </WidgetState>
    );
  },
});
