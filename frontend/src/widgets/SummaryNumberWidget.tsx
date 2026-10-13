import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import { includeTransfersField, periodField, scopeFields, scopeOf } from "./fields";
import { ScopeCaption } from "./ScopeCaption";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

const METRICS = [
  { value: "spending", label: "Spending" },
  { value: "income", label: "Income" },
  { value: "net", label: "Net (income minus spending)" },
  { value: "count", label: "Number of transactions" },
  { value: "avg-transaction", label: "Average per transaction" },
  { value: "avg-day", label: "Average spending per day" },
  { value: "savings-rate", label: "Savings rate (net as a share of income)" },
] as const;

type Totals = Summary["totals"];

const daysIn = (from: string, to: string): number =>
  Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
  );

/** The chosen figure from a period's totals; null when it can't be worked out (no income). */
export function metricValue(metric: string, t: Totals, days: number): number | null {
  switch (metric) {
    case "income":
      return t.incomeMinor;
    case "net":
      return t.netMinor;
    case "count":
      return t.count;
    case "avg-transaction":
      return t.count > 0 ? Math.round(t.spendingMinor / t.count) : null;
    case "avg-day":
      return Math.round(t.spendingMinor / days);
    case "savings-rate":
      return t.incomeMinor > 0 ? t.netMinor / t.incomeMinor : null;
    default:
      return t.spendingMinor;
  }
}

/** The figure in words. */
export function formatMetric(metric: string, value: number | null): string {
  if (value === null) return "—";
  if (metric === "count") return value.toLocaleString();
  if (metric === "savings-rate") return `${Math.round(value * 1000) / 10}%`;
  return formatMinor(value, "USD");
}

/** Whether more of this is good (income, net, savings) or not (spending). */
const moreIsGood = (metric: string) => ["income", "net", "savings-rate"].includes(metric);

export default defineWidget({
  id: "summary-number",
  title: "Summary number",
  description:
    "One figure you choose (spending, income, net, count, averages, savings rate) for any period, account, bank or category, compared with the period before.",
  group: "Spending",
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 2 },
  order: 400,
  defaultConfig: {
    metric: "spending",
    period: "this-month",
    accountId: "",
    institution: "",
    categoryId: "",
    includeTransfers: false,
    compare: true,
  },
  configFields: [
    { key: "metric", label: "Figure", type: "select", options: METRICS },
    periodField,
    ...scopeFields,
    includeTransfersField,
    { key: "compare", label: "Compare with the period before", type: "boolean" },
  ],
  Component: function SummaryNumber({ config }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const scope = scopeOf(config);
    const params = {
      ...scope,
      groupBy: "none" as const,
      includeTransfers: config.includeTransfers,
    };
    const now = useApi<Summary>(summaryPath({ from: period.from, to: period.to, ...params }));
    const before = useApi<Summary>(
      config.compare
        ? summaryPath({ from: period.previous.from, to: period.previous.to, ...params })
        : null,
    );
    const value = now.data
      ? metricValue(config.metric, now.data.totals, daysIn(period.from, period.to))
      : null;
    const previous = before.data
      ? metricValue(
          config.metric,
          before.data.totals,
          daysIn(period.previous.from, period.previous.to),
        )
      : null;
    const change =
      value !== null && previous !== null && previous !== 0
        ? (value - previous) / Math.abs(previous)
        : null;
    const label = METRICS.find((m) => m.value === config.metric)?.label ?? "Spending";

    return (
      <WidgetState loading={now.loading} error={now.error}>
        <div className="flex h-full flex-col justify-center">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {label}, {period.label}
          </div>
          <div className="text-3xl font-semibold tabular-nums">
            {formatMetric(config.metric, value)}
          </div>
          {config.compare && change !== null && (
            <div
              className={`text-xs tabular-nums ${
                change === 0
                  ? "text-slate-500"
                  : change > 0 === moreIsGood(config.metric)
                    ? "text-green-700 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
              }`}
            >
              {change > 0 ? "▲" : change < 0 ? "▼" : "="} {Math.abs(Math.round(change * 100))}% vs{" "}
              {period.previousLabel} ({formatMetric(config.metric, previous)})
            </div>
          )}
          <ScopeCaption config={config} />
        </div>
      </WidgetState>
    );
  },
});
