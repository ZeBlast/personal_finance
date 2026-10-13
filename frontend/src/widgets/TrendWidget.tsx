import { useMemo } from "react";
import { ColumnChart } from "../components/charts/ColumnChart";
import { LineChart } from "../components/charts/LineChart";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import { includeTransfersField, periodField, scopeFields, scopeOf } from "./fields";
import { ScopeCaption } from "./ScopeCaption";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

const SERIES = {
  spending: {
    label: "Spending",
    color: "#ef4444",
    pick: (r: Summary["rows"][number]) => r.spendingMinor,
  },
  income: {
    label: "Income",
    color: "#16a34a",
    pick: (r: Summary["rows"][number]) => r.incomeMinor,
  },
  net: { label: "Net", color: "#2563eb", pick: (r: Summary["rows"][number]) => r.netMinor },
} as const;
type SeriesKey = keyof typeof SERIES;

const money = (n: number) => formatMinor(n, "USD");
const short = (n: number) =>
  Math.abs(n) >= 100_000 ? `$${Math.round(n / 100_000)}k` : `$${Math.round(n / 100)}`;

/** A bucket's key as a short label: "Oct 3", "wk Oct 3", "Oct". */
function bucketLabel(key: string, bucket: string): string {
  const date = new Date(`${key.length === 7 ? `${key}-01` : key}T00:00:00Z`);
  const month = date.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
  if (bucket === "month") return month;
  return `${month} ${date.getUTCDate()}`;
}

export default defineWidget({
  id: "trend-over-time",
  title: "Trend over time",
  description:
    "Spending, income or net by day, week or month, as columns or a line, for any account, bank or category.",
  group: "Spending",
  defaultSize: { w: 6, h: 5 },
  minSize: { w: 3, h: 3 },
  order: 410,
  defaultConfig: {
    show: "spending",
    bucket: "week",
    chart: "columns",
    period: "last-90-days",
    accountId: "",
    institution: "",
    categoryId: "",
    includeTransfers: false,
  },
  configFields: [
    {
      key: "show",
      label: "Show",
      type: "select",
      options: [
        { value: "spending", label: "Spending" },
        { value: "income", label: "Income" },
        { value: "net", label: "Net" },
        { value: "both", label: "Income and spending" },
      ],
    },
    {
      key: "bucket",
      label: "In steps of",
      type: "select",
      options: [
        { value: "day", label: "Days" },
        { value: "week", label: "Weeks" },
        { value: "month", label: "Months" },
      ],
    },
    {
      key: "chart",
      label: "Chart",
      type: "select",
      options: [
        { value: "columns", label: "Columns" },
        { value: "line", label: "Line" },
      ],
    },
    periodField,
    ...scopeFields,
    includeTransfersField,
  ],
  Component: function Trend({ config }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const bucket = config.bucket as "day" | "week" | "month";
    const { data, error, loading } = useApi<Summary>(
      summaryPath({
        from: period.from,
        to: period.to,
        groupBy: bucket,
        fill: true,
        includeTransfers: config.includeTransfers,
        ...scopeOf(config),
      }),
    );
    const keys: SeriesKey[] =
      config.show === "both" ? ["income", "spending"] : [config.show as SeriesKey];
    const rows = data?.rows ?? [];
    const empty = data !== null && rows.every((r) => keys.every((k) => SERIES[k].pick(r) === 0));

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={empty}
        emptyText={`Nothing ${period.label}.`}
      >
        <div className="flex h-full flex-col gap-1">
          <ScopeCaption config={config} prefix={period.label} />
          <div className="min-h-0 flex-1">
            {config.chart === "line" ? (
              <LineChart
                series={keys.map((k) => ({
                  key: k,
                  label: SERIES[k].label,
                  color: SERIES[k].color,
                  points: rows.map((r) => ({
                    date: r.key.length === 7 ? `${r.key}-01` : r.key,
                    value: SERIES[k].pick(r),
                  })),
                }))}
                format={money}
                formatAxis={short}
              />
            ) : (
              <ColumnChart
                fit
                series={keys.map((k) => ({
                  key: k,
                  label: SERIES[k].label,
                  color: SERIES[k].color,
                }))}
                groups={rows.map((r) => ({
                  key: r.key,
                  label: bucketLabel(r.key, bucket),
                  values: keys.map((k) => SERIES[k].pick(r)),
                }))}
                format={money}
                formatAxis={short}
                {...(config.show === "net"
                  ? { colorFor: (v: number) => (v >= 0 ? "#16a34a" : "#ef4444") }
                  : {})}
              />
            )}
          </div>
        </div>
      </WidgetState>
    );
  },
});
