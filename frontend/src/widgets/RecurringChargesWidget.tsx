import { useApi } from "../hooks/useApi";
import { dueLabel } from "../lib/insights";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import type { RecurringReport } from "../types/insights";
import { countField } from "./fields";
import { Stat, WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "recurring-charges",
  title: "Recurring charges",
  description:
    "Subscriptions, rent, and bills the app has noticed repeating, and what is due in the next 30 days.",
  group: "Activity",
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 4 },
  defaultEnabled: true,
  order: 45,
  defaultConfig: { show: "out", topN: 6 },
  configFields: [
    {
      key: "show",
      label: "Show",
      type: "select",
      options: [
        { value: "out", label: "Charges (money out)" },
        { value: "in", label: "Deposits (money in)" },
        { value: "both", label: "Both" },
      ],
    },
    countField("topN", "Upcoming items to list", 3, 15),
  ],
  Component: function RecurringCharges({ config }) {
    const { data, error, loading } = useApi<RecurringReport>("/insights/recurring");
    const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
    const wanted = (direction: string): boolean =>
      config.show === "both" || config.show === direction;
    const upcoming = (data?.upcoming ?? [])
      .filter((u) => wanted(u.direction))
      .slice(0, config.topN);
    const active = (data?.series ?? []).filter((s) => s.status === "active" && wanted(s.direction));
    const monthly =
      config.show === "in"
        ? data?.monthlyInMinor
        : config.show === "both"
          ? undefined
          : data?.monthlyOutMinor;

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.series.length === 0}
        emptyText="Nothing repeating found yet. Patterns show up after a few months of transactions."
      >
        <div className="space-y-3">
          {monthly !== undefined && (
            <Stat
              label={config.show === "in" ? "Regular deposits" : "Recurring charges"}
              value={`${money(monthly)} / month`}
              note={`${active.length} active ${active.length === 1 ? "item" : "items"}`}
            />
          )}
          <div>
            <h3 className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              Next 30 days
            </h3>
            {upcoming.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">Nothing expected.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {upcoming.map((u) => (
                  <li key={u.key} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate">{u.merchant}</span>
                      <span className="block text-xs text-slate-500">
                        {formatDay(u.date)} · {dueLabel(u.date, data?.asOf ?? u.date)}
                        {u.overdue ? " (not seen yet)" : ""}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 tabular-nums ${u.direction === "in" ? "text-green-700 dark:text-green-400" : ""}`}
                    >
                      {u.direction === "in" ? "+" : ""}
                      {money(u.amountMinor)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Monthly figures are estimates from past payments.
          </p>
        </div>
      </WidgetState>
    );
  },
});
