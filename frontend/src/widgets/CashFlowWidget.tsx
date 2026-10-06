import { useMemo } from "react";
import { ColumnChart } from "../components/charts/ColumnChart";
import { INCOME_COLOR, SPENDING_COLOR } from "../components/charts/palette";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatAxisMoney, formatMinor } from "../lib/money";
import { monthShort, recentMonths } from "../lib/period";
import type { Summary } from "../types/analytics";
import { accountField, includeTransfersField, monthsField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "cash-flow",
  title: "Cash flow",
  description: "What was left over each month: income minus spending, above or below zero.",
  group: "Spending",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  order: 80,
  defaultConfig: { months: "6", accountId: "", includeTransfers: false },
  configFields: [monthsField, accountField, includeTransfersField],
  Component: function CashFlow({ config }) {
    const range = useMemo(() => recentMonths(Number(config.months)), [config.months]);
    const { data, error, loading } = useApi<Summary>(
      summaryPath({
        ...range,
        groupBy: "month",
        fill: true,
        accountId: config.accountId,
        includeTransfers: config.includeTransfers,
      }),
    );
    const empty = data !== null && data.totals.count === 0;
    const net = data?.totals.netMinor ?? 0;

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={empty}
        emptyText="No transactions in this period yet."
      >
        {data && (
          <div className="space-y-2">
            <p className="text-sm">
              <span className="text-slate-500">Over these months: </span>
              <span
                className={`font-semibold tabular-nums ${net < 0 ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}
              >
                {net >= 0 ? "+" : ""}
                {formatMinor(net, "USD")}
              </span>
            </p>
            <ColumnChart
              series={[{ key: "net", label: "Left over", color: INCOME_COLOR }]}
              groups={data.rows.map((r) => ({
                key: r.key,
                label: monthShort(r.key),
                values: [r.netMinor],
              }))}
              format={(n) => formatMinor(n, "USD")}
              formatAxis={formatAxisMoney}
              colorFor={(value) => (value < 0 ? SPENDING_COLOR : INCOME_COLOR)}
            />
          </div>
        )}
      </WidgetState>
    );
  },
});
