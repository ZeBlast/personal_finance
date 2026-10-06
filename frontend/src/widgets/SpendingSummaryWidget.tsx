import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { summaryPath } from "../lib/analytics";
import { formatMinor } from "../lib/money";
import { resolvePeriod } from "../lib/period";
import type { Summary } from "../types/analytics";
import { accountField, includeTransfersField, periodField } from "./fields";
import { Stat, WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "spending-summary",
  title: "Spending",
  description: "How much you spent in a period, compared with the period before it.",
  group: "Spending",
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  defaultEnabled: true,
  order: 40,
  defaultConfig: { period: "this-month", accountId: "", includeTransfers: false },
  configFields: [periodField, accountField, includeTransfersField],
  Component: function SpendingSummary({ config }) {
    const period = useMemo(() => resolvePeriod(config.period), [config.period]);
    const base = { accountId: config.accountId, includeTransfers: config.includeTransfers };
    const current = useApi<Summary>(summaryPath({ ...base, from: period.from, to: period.to }));
    const previous = useApi<Summary>(
      summaryPath({ ...base, from: period.previous.from, to: period.previous.to }),
    );

    const spent = current.data?.totals.spendingMinor ?? 0;
    const before = previous.data?.totals.spendingMinor ?? 0;
    const difference = spent - before;
    const percent = before > 0 ? Math.round((Math.abs(difference) / before) * 100) : null;

    return (
      <WidgetState
        loading={current.loading || previous.loading}
        error={current.error ?? previous.error}
      >
        <div className="space-y-3">
          <Stat
            label={`Spent ${period.label}`}
            value={formatMinor(spent, "USD")}
            note={`${current.data?.totals.count ?? 0} transactions`}
          />
          <p className="text-sm">
            {before === 0 && spent === 0 ? (
              <span className="text-slate-500">Nothing spent in either period.</span>
            ) : difference === 0 ? (
              <span className="text-slate-500">The same as {period.previousLabel}.</span>
            ) : (
              <>
                <span
                  className={
                    difference > 0
                      ? "font-medium text-red-600 dark:text-red-400"
                      : "font-medium text-green-700 dark:text-green-400"
                  }
                >
                  {difference > 0 ? "▲" : "▼"} {formatMinor(Math.abs(difference), "USD")}
                  {percent !== null ? ` (${percent}%)` : ""}
                </span>
                <span className="text-slate-500">
                  {" "}
                  {difference > 0 ? "more" : "less"} than {period.previousLabel}
                </span>
                <span className="text-slate-500"> ({formatMinor(before, "USD")})</span>
              </>
            )}
          </p>
          <div className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 text-sm dark:border-slate-700">
            <Stat
              label="Income"
              value={formatMinor(current.data?.totals.incomeMinor ?? 0, "USD")}
            />
            <Stat
              label="Left over"
              value={formatMinor(current.data?.totals.netMinor ?? 0, "USD")}
              tone={(current.data?.totals.netMinor ?? 0) < 0 ? "bad" : undefined}
            />
          </div>
        </div>
      </WidgetState>
    );
  },
});
