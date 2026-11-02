import { Link } from "react-router-dom";
import { CapMeter, CapStatusLabel } from "../components/charts/CapMeter";
import { useApi } from "../hooks/useApi";
import { capDetail, capReading, daysLeftIn, sortCaps } from "../lib/caps";
import { formatMinor } from "../lib/money";
import { monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import type { BudgetMonth } from "../types/analytics";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "budget-progress",
  title: "Spending caps",
  description: "How each category is doing against its monthly cap, and where it looks set to end.",
  group: "Spending caps",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 3, h: 3 },
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
    const day = today();
    const { data, error, loading } = useApi<BudgetMonth>(`/budgets?month=${month}&today=${day}`);
    const daysLeft = daysLeftIn(month, day);
    const money = (n: number) => formatMinor(n, "USD");

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.budgets.length === 0}
        emptyText={`No caps for ${monthLabel(month, "long")} yet. A cap sets the most to spend on a category.`}
        emptyAction={{ to: "/planning/budgets", label: "Set a cap" }}
      >
        {data && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              <span className="font-medium tabular-nums">{money(data.totals.spentMinor)}</span> of{" "}
              <span className="tabular-nums">{money(data.totals.budgetedMinor)}</span> in caps for{" "}
              {monthLabel(month, "long")}
            </p>
            <ul className="space-y-3">
              {sortCaps(data.budgets).map((b) => (
                <li key={b.categoryId} className="text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{b.categoryName}</span>
                    <span className="shrink-0 tabular-nums">
                      {money(b.spentMinor)}
                      <span className="text-slate-500"> / {money(b.availableMinor)}</span>
                    </span>
                  </div>
                  <CapMeter
                    spentMinor={b.spentMinor}
                    capMinor={b.availableMinor}
                    expectedMinor={b.expectedMinor}
                    projectedMinor={b.projectedMinor}
                    color={b.categoryColor}
                    label={`${b.categoryName} cap`}
                    description={capReading(b, daysLeft, money)}
                  />
                  <div className="flex flex-wrap items-center gap-x-2">
                    <CapStatusLabel status={b.status} />
                    <span className="text-xs text-slate-500">{capDetail(b, daysLeft, money)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Link to="/planning/budgets" className="mt-3 inline-block text-xs text-blue-600 underline">
          Manage caps
        </Link>
      </WidgetState>
    );
  },
});
