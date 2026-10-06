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
  id: "income-vs-spending",
  title: "Income vs spending",
  description: "Money in and money out for each of the last few months.",
  group: "Spending",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  defaultEnabled: true,
  order: 70,
  defaultConfig: { months: "6", accountId: "", includeTransfers: false },
  configFields: [monthsField, accountField, includeTransfersField],
  Component: function IncomeVsSpending({ config }) {
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

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={empty}
        emptyText="No transactions in this period yet."
      >
        {data && (
          <ColumnChart
            series={[
              { key: "income", label: "Income", color: INCOME_COLOR },
              { key: "spending", label: "Spending", color: SPENDING_COLOR },
            ]}
            groups={data.rows.map((r) => ({
              key: r.key,
              label: monthShort(r.key),
              values: [r.incomeMinor, Math.max(0, r.spendingMinor)],
            }))}
            format={(n) => formatMinor(n, "USD")}
            formatAxis={formatAxisMoney}
          />
        )}
      </WidgetState>
    );
  },
});
