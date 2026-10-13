import { useMemo } from "react";
import { BarList } from "../components/charts/BarList";
import { Donut } from "../components/charts/Donut";
import { CHART_COLORS } from "../components/charts/palette";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import { countField, includeTransfersField, periodField, scopeFields, scopeOf } from "./fields";
import { ScopeCaption } from "./ScopeCaption";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

const money = (n: number) => formatMinor(n, "USD");

export default defineWidget({
  id: "breakdown",
  title: "Breakdown",
  description:
    "Spending or income split by category, merchant, account or bank, as a donut or bars, for any account, bank or category.",
  group: "Spending",
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 3 },
  order: 420,
  defaultConfig: {
    by: "category",
    measure: "spending",
    display: "donut",
    top: 8,
    period: "this-month",
    accountId: "",
    institution: "",
    categoryId: "",
    includeTransfers: false,
  },
  configFields: [
    {
      key: "by",
      label: "Split by",
      type: "select",
      options: [
        { value: "category", label: "Category" },
        { value: "merchant", label: "Merchant" },
        { value: "account", label: "Account" },
        { value: "institution", label: "Bank" },
      ],
    },
    {
      key: "measure",
      label: "Of",
      type: "select",
      options: [
        { value: "spending", label: "Spending" },
        { value: "income", label: "Income" },
      ],
    },
    {
      key: "display",
      label: "Show as",
      type: "select",
      options: [
        { value: "donut", label: "Donut" },
        { value: "bars", label: "Bars" },
      ],
    },
    countField("top", "How many to show (the rest as Other)", 3, 20),
    periodField,
    ...scopeFields,
    includeTransfersField,
  ],
  Component: function Breakdown({ config }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const { data, error, loading } = useApi<Summary>(
      summaryPath({
        from: period.from,
        to: period.to,
        groupBy: config.by as "category" | "merchant" | "account" | "institution",
        rollupToParent: config.by === "category" && !config.categoryId,
        limit: config.top,
        includeTransfers: config.includeTransfers,
        ...scopeOf(config),
      }),
    );
    const pick = (r: Summary["rows"][number]) =>
      config.measure === "income" ? r.incomeMinor : r.spendingMinor;
    const rows = (data?.rows ?? [])
      .filter((r) => pick(r) > 0)
      .map((r, i) => ({
        key: r.key,
        label: r.label,
        value: pick(r),
        color: r.color ?? CHART_COLORS[i % CHART_COLORS.length],
      }));
    const total = rows.reduce((n, r) => n + r.value, 0);

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && rows.length === 0}
        emptyText={`No ${config.measure} ${period.label}.`}
      >
        <div className="flex h-full flex-col gap-2">
          <ScopeCaption config={config} prefix={period.label} />
          {config.display === "bars" ? (
            <BarList rows={rows} format={money} />
          ) : (
            <Donut
              slices={rows}
              format={money}
              center={
                <span className="text-center text-xs">
                  <span className="block font-semibold tabular-nums">{money(total)}</span>
                  {config.measure}
                </span>
              }
            />
          )}
        </div>
      </WidgetState>
    );
  },
});
