import { Link } from "react-router-dom";
import { ProgressBar } from "../components/charts/ProgressBar";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import type { BudgetMonth } from "../types/analytics";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "budget-progress",
  title: "Budgets",
  description: "How much of each category's monthly budget you have used.",
  group: "Budgets",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 3, h: 3 },
  defaultEnabled: true,
  order: 45,
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
  Component: function BudgetProgress({ config }) {
    const thisMonth = monthOf(today());
    const month = config.month === "previous" ? shiftMonth(thisMonth, -1) : thisMonth;
    const { data, error, loading } = useApi<BudgetMonth>(`/budgets?month=${month}`);
    const money = (n: number) => formatMinor(n, "USD");

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.budgets.length === 0}
        emptyText={`No budgets for ${monthLabel(month, "long")} yet.`}
      >
        {data && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              <span className="font-medium tabular-nums">{money(data.totals.spentMinor)}</span> of{" "}
              <span className="tabular-nums">{money(data.totals.budgetedMinor)}</span> budgeted in{" "}
              {monthLabel(month, "long")}
            </p>
            <ul className="space-y-3">
              {data.budgets.map((b) => (
                <li key={b.id} className="text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{b.categoryName}</span>
                    <span
                      className={`shrink-0 tabular-nums ${b.overspent ? "font-medium text-red-600 dark:text-red-400" : ""}`}
                    >
                      {money(b.spentMinor)} / {money(b.amountMinor)}
                    </span>
                  </div>
                  <ProgressBar
                    value={b.spentMinor}
                    max={b.amountMinor}
                    label={`${b.categoryName} budget`}
                    color={b.categoryColor}
                  />
                  <div
                    className={`text-xs ${b.overspent ? "text-red-600 dark:text-red-400" : "text-slate-500"}`}
                  >
                    {b.overspent
                      ? `${money(-b.remainingMinor)} over budget`
                      : `${money(b.remainingMinor)} left`}{" "}
                    · {b.percentUsed}%
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Link to="/budgets" className="mt-3 inline-block text-xs text-blue-600 underline">
          Manage budgets
        </Link>
      </WidgetState>
    );
  },
});
