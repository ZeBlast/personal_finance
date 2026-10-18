import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { monthShort } from "../lib/period";
import { accountField, categoryField } from "./fields";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export interface SpendingMonitor {
  month: string;
  today: string;
  spentMinor: number;
  projectedMinor: number;
  averageMinor: number;
  sameDayAverageMinor: number;
  changePercent: number | null;
  months: Array<{ month: string; spentMinor: number }>;
  unknownTag: boolean;
}

/** The query for a monitor's settings; empty settings are left out. Pure. */
export function monitorPath(config: Record<string, unknown>): string {
  const params = new URLSearchParams();
  const put = (name: string, key: string) => {
    const value = typeof config[key] === "string" ? (config[key] as string).trim() : "";
    if (value) params.set(name, value);
  };
  put("category", "categoryId");
  put("accountId", "accountId");
  put("merchant", "merchant");
  put("tag", "tag");
  const q = params.toString();
  return `/analytics/monitor${q ? `?${q}` : ""}`;
}

/** This month against the same days of recent months, in words. Pure. */
export function paceText(m: SpendingMonitor): string {
  if (m.changePercent === null) return "Nothing to compare with in the last three months.";
  if (m.changePercent === 0) return "The same as usual by this day of the month.";
  return `${Math.abs(m.changePercent)}% ${m.changePercent > 0 ? "more" : "less"} than usual by this day of the month.`;
}

export default defineWidget({
  id: "spending-monitor",
  title: "Spending monitor",
  description:
    "Follow one thing: a category, account, merchant or tag. This month so far against usual, and where it is heading.",
  group: "Spending",
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 4 },
  order: 140,
  defaultConfig: { categoryId: "", accountId: "", merchant: "", tag: "" },
  configFields: [
    categoryField,
    accountField,
    {
      key: "merchant",
      label: "Merchant name contains",
      type: "text",
      maxLength: 200,
      help: "Such as coffee or amazon. Leave empty for all merchants.",
    },
    {
      key: "tag",
      label: "Tag",
      type: "text",
      maxLength: 80,
      help: "A tag's name, as given to transactions. Leave empty for all.",
    },
  ],
  Component: function SpendingMonitorCard({ config }) {
    const { data, error, loading } = useApi<SpendingMonitor>(monitorPath(config));
    const money = (n: number) => formatMinor(n, "USD");
    const most = Math.max(1, ...(data?.months.map((m) => m.spentMinor) ?? [1]));
    return (
      <WidgetState loading={loading} error={error} empty={false} emptyText="">
        {data && (
          <div className="space-y-2 text-sm">
            {data.unknownTag && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                No tag is named “{String(config["tag"])}”. Check its spelling in the widget's
                settings.
              </p>
            )}
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums">{money(data.spentMinor)}</span>
              <span className="text-xs text-slate-500">
                heading for {money(data.projectedMinor)}
              </span>
            </div>
            <p
              className={`text-xs ${(data.changePercent ?? 0) > 15 ? "text-red-600 dark:text-red-400" : "text-slate-500"}`}
            >
              {paceText(data)} A whole month is usually {money(data.averageMinor)}.
            </p>
            <div className="flex h-16 items-end gap-1" aria-hidden="true">
              {data.months.map((m, i) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-0.5">
                  <div
                    className={`w-full rounded-t ${i === data.months.length - 1 ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-600"}`}
                    style={{ height: `${Math.max(2, (m.spentMinor / most) * 48)}px` }}
                    title={`${monthShort(m.month)}: ${money(m.spentMinor)}`}
                  />
                  <span className="text-[10px] text-slate-500">{monthShort(m.month)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </WidgetState>
    );
  },
});
