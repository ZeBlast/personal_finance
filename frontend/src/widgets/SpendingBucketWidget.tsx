import { Link } from "react-router-dom";
import { CapStatusLabel } from "../components/charts/CapMeter";
import { SpendingBucket } from "../components/charts/SpendingBucket";
import { AnimatedNumber } from "../components/common/AnimatedNumber";
import { useApi } from "../hooks/useApi";
import { useCategories } from "../hooks/useCategories";
import { capDetail, capReading, daysLeftIn, totalExpected } from "../lib/caps";
import { formatMinor } from "../lib/money";
import { firstOfMonth, lastOfMonth, monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import type { Budget, BudgetMonth, CapStatus } from "../types/analytics";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/**
 * What a bucket shows: one category's cap, or with none chosen, every cap together. Null when the
 * chosen category has no cap this month. Pure.
 */
export function bucketReading(
  data: BudgetMonth,
  categoryId: number | null,
):
  | (Pick<
      Budget,
      | "status"
      | "spentMinor"
      | "availableMinor"
      | "remainingMinor"
      | "expectedMinor"
      | "projectedMinor"
    > & { name: string; color: string | null })
  | null {
  if (categoryId !== null) {
    const cap = data.budgets.find((b) => b.categoryId === categoryId);
    return cap ? { ...cap, name: cap.categoryName, color: cap.categoryColor } : null;
  }
  if (data.budgets.length === 0) return null;
  const { spentMinor, budgetedMinor, remainingMinor } = data.totals;
  const status: CapStatus =
    spentMinor > budgetedMinor ? "over" : spentMinor === budgetedMinor ? "full" : "ok";
  const hasPace = data.budgets.some((b) => b.expectedMinor !== null);
  return {
    name: "All spending caps",
    color: null,
    status,
    spentMinor,
    availableMinor: budgetedMinor,
    remainingMinor,
    expectedMinor: hasPace ? totalExpected(data.budgets) : null,
    projectedMinor: null,
  };
}

export default defineWidget({
  id: "spending-bucket",
  title: "Spending bucket",
  description:
    "A bucket that fills with a category's spending this month. The rim is your spending cap.",
  group: "Spending caps",
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 2, h: 3 },
  order: 46,
  headerless: true,
  defaultConfig: { category: "", month: "current", water: "status" },
  configFields: [
    {
      key: "category",
      label: "Spending cap to show",
      help: "All categories fills one bucket with every cap together. Add this widget again for another bucket.",
      type: "category",
    },
    {
      key: "month",
      label: "Month",
      type: "select",
      options: [
        { value: "current", label: "This month" },
        { value: "previous", label: "Last month" },
      ],
    },
    {
      key: "water",
      label: "Water colour",
      type: "select",
      options: [
        { value: "status", label: "Follows how the cap is doing" },
        { value: "category", label: "The category's colour" },
      ],
    },
  ],
  Component: function Bucket({ config }) {
    const day = today();
    const thisMonth = monthOf(day);
    const month = config.month === "previous" ? shiftMonth(thisMonth, -1) : thisMonth;
    const { data, error, loading } = useApi<BudgetMonth>(`/budgets?month=${month}&today=${day}`);
    const { categories } = useCategories();
    const categoryId = config.category ? Number(config.category) : null;
    const reading = data ? bucketReading(data, categoryId) : null;
    const money = (n: number) => formatMinor(n, "USD");
    const daysLeft = daysLeftIn(month, day);
    const wanted = categories?.find((c) => c.id === categoryId)?.name ?? "this category";

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && reading === null}
        emptyText={
          categoryId === null
            ? `No spending caps for ${monthLabel(month, "long")} yet. Set one to fill this bucket.`
            : `No spending cap on ${wanted} for ${monthLabel(month, "long")}. Set one to fill this bucket.`
        }
        emptyAction={{ to: "/planning/budgets", label: "Set a cap" }}
      >
        {reading && (
          <div className="@container h-full">
            <div className="flex h-full flex-col items-center gap-2 @min-[28rem]:flex-row @min-[28rem]:gap-4">
              <div className="min-h-0 w-full flex-1 @min-[28rem]:h-full @min-[28rem]:w-auto @min-[28rem]:basis-1/2">
                <SpendingBucket
                  spentMinor={reading.spentMinor}
                  capMinor={reading.availableMinor}
                  expectedMinor={reading.expectedMinor}
                  status={reading.status}
                  color={config.water === "category" ? reading.color : null}
                  label={`${reading.name} spending bucket`}
                  description={capReading(reading, daysLeft, money)}
                />
              </div>
              <div className="w-full min-w-0 shrink-0 text-center @min-[28rem]:w-auto @min-[28rem]:flex-1 @min-[28rem]:text-left">
                {categoryId === null ? (
                  <div className="truncate text-sm font-semibold">{reading.name}</div>
                ) : (
                  <Link
                    to={`/transactions?${new URLSearchParams({
                      category: String(categoryId),
                      from: firstOfMonth(month),
                      to: lastOfMonth(month),
                    }).toString()}`}
                    title={`See ${reading.name} transactions for ${monthLabel(month, "long")}`}
                    className="block truncate text-sm font-semibold hover:underline"
                  >
                    {reading.name}
                  </Link>
                )}
                <div className="text-2xl font-semibold">
                  <AnimatedNumber value={reading.spentMinor} format={money} />
                </div>
                <div className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                  of {money(reading.availableMinor)}
                  {config.month === "previous" && ` in ${monthLabel(month)}`}
                </div>
                <div className="mt-1 flex min-h-8 flex-wrap content-start items-center justify-center gap-x-2 @min-[28rem]:justify-start">
                  <CapStatusLabel status={reading.status} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {capDetail(reading, daysLeft, money)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </WidgetState>
    );
  },
});
