import { heatmapPath, SpendingHeatmap } from "../components/views/SpendingHeatmap";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { today } from "../lib/period";
import type { Summary } from "../types/analytics";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "spending-heatmap",
  title: "Spending by day",
  description: "A calendar shaded by each day's spending, to show patterns like weekend spikes.",
  group: "Spending",
  defaultSize: { w: 8, h: 3 },
  minSize: { w: 4, h: 3 },
  order: 62,
  defaultConfig: { weeks: "26", weekdays: true },
  configFields: [
    {
      key: "weeks",
      label: "How far back",
      type: "select",
      options: [
        { value: "13", label: "3 months" },
        { value: "26", label: "6 months" },
        { value: "52", label: "1 year" },
      ],
    },
    { key: "weekdays", label: "Show averages by day of the week", type: "boolean" },
  ],
  Component: function Heatmap({ config }) {
    const end = today();
    const weeks = Number(config.weeks);
    const { data, error, loading } = useApi<Summary>(heatmapPath(end, weeks));
    return (
      <WidgetState loading={loading} error={error}>
        {data && (
          <SpendingHeatmap
            rows={data.rows}
            end={end}
            weeks={weeks}
            money={(n) => formatMinor(n, "USD")}
            showWeekdays={Boolean(config.weekdays)}
          />
        )}
      </WidgetState>
    );
  },
});
