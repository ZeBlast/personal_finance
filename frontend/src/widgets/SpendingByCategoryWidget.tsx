import { useMemo } from "react";
import { BarList } from "../components/charts/BarList";
import { Donut } from "../components/charts/Donut";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import { accountField, countField, includeTransfersField, periodField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "spending-by-category",
  title: "Spending by category",
  description: "Where your money went in a period, as a donut or a list of bars.",
  group: "Spending",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 4 },
  order: 50,
  defaultConfig: {
    period: "this-month",
    accountId: "",
    view: "donut",
    topN: 6,
    groupSubcategories: true,
    includeTransfers: false,
  },
  configFields: [
    periodField,
    accountField,
    {
      key: "view",
      label: "Show as",
      type: "select",
      options: [
        { value: "donut", label: "Donut chart" },
        { value: "bars", label: "Bars" },
      ],
    },
    countField("topN", "Categories to show", 3, 15),
    {
      key: "groupSubcategories",
      label: "Group subcategories under their parent",
      type: "boolean",
    },
    includeTransfersField,
  ],
  Component: function SpendingByCategory({ config }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const { data, error, loading } = useApi<Summary>(
      summaryPath({
        from: period.from,
        to: period.to,
        groupBy: "category",
        accountId: config.accountId,
        includeTransfers: config.includeTransfers,
        rollupToParent: config.groupSubcategories,
        limit: config.topN,
      }),
    );

    // Categories with no spending (for example one that only holds income) are not part of the picture.
    const rows = (data?.rows ?? []).filter((r) => r.spendingMinor > 0);
    const money = (n: number) => formatMinor(n, "USD");

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && rows.length === 0}
        emptyText={`No spending ${period.label}.`}
      >
        {config.view === "bars" ? (
          <BarList
            rows={rows.map((r) => ({
              key: r.key,
              label: r.label,
              value: r.spendingMinor,
              color: r.color,
            }))}
            format={money}
          />
        ) : (
          <Donut
            slices={rows.map((r) => ({
              key: r.key,
              label: r.label,
              value: r.spendingMinor,
              color: r.color,
            }))}
            format={money}
            center={
              <>
                <span className="text-xs text-slate-500">Spent</span>
                <span className="text-sm font-semibold tabular-nums">
                  {money(data?.totals.spendingMinor ?? 0)}
                </span>
              </>
            }
          />
        )}
      </WidgetState>
    );
  },
});
