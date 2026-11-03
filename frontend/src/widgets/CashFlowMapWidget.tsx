import { cashFlowPath, CashFlowMap } from "../components/views/CashFlowMap";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { monthOf, shiftMonth, today } from "../lib/period";
import type { Summary } from "../types/analytics";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "cash-flow-map",
  title: "Cash-flow map",
  description: "Where a month's money came from and where it went, drawn as one picture.",
  group: "Spending",
  defaultSize: { w: 12, h: 6 },
  minSize: { w: 6, h: 4 },
  order: 60,
  framed: true,
  defaultConfig: { month: "current" },
  configFields: [
    {
      key: "month",
      label: "Month",
      type: "select",
      options: [
        { value: "current", label: "This month" },
        { value: "previous", label: "Last month" },
      ],
    },
  ],
  Component: function CashFlow({ config, size }) {
    const thisMonth = monthOf(today());
    const month = config.month === "previous" ? shiftMonth(thisMonth, -1) : thisMonth;
    const { data, error, loading } = useApi<Summary>(cashFlowPath(month));
    return (
      <WidgetState loading={loading} error={error}>
        {data && (
          <CashFlowMap
            rows={data.rows}
            month={month}
            money={(n) => formatMinor(n, "USD")}
            height={Math.max(180, size.h * 78 - 84)}
          />
        )}
      </WidgetState>
    );
  },
});
