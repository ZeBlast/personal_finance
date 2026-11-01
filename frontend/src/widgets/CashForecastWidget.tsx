import { AnnotatedForecast } from "../components/views/AnnotatedForecast";
import { useApi } from "../hooks/useApi";
import type { Forecast } from "../types/planning";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "cash-forecast",
  title: "The days ahead",
  description:
    "Your cash over the coming days, with the lowest point and every bill and paycheck marked.",
  group: "Planning",
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 4, h: 4 },
  order: 8,
  defaultConfig: { days: "60", whatIf: false },
  configFields: [
    {
      key: "days",
      label: "Look ahead",
      type: "select",
      options: [
        { value: "30", label: "30 days" },
        { value: "60", label: "60 days" },
        { value: "90", label: "90 days" },
        { value: "180", label: "180 days" },
      ],
    },
    { key: "whatIf", label: "Show the what-if slider", type: "boolean" },
  ],
  Component: function CashForecast({ config, size }) {
    const { data, error, loading } = useApi<Forecast>(`/forecast?days=${String(config.days)}`);
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.accountsCounted === 0}
        emptyText="Add a checking or savings account to see the days ahead."
        emptyAction={{ to: "/accounts", label: "Add an account" }}
      >
        {data && (
          <AnnotatedForecast
            forecast={data}
            whatIf={Boolean(config.whatIf)}
            height={Math.max(120, size.h * 78 - (config.whatIf ? 150 : 88))}
          />
        )}
      </WidgetState>
    );
  },
});
