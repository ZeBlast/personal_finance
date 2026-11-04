import { HowThisWorks } from "../components/common/HowThisWorks";
import { CategoryExplorer } from "../components/insights/CategoryExplorer";
import { useApi } from "../hooks/useApi";
import { spendingSentence } from "../lib/pageSummaries";
import { monthLabel, monthOf, today } from "../lib/period";
import type { MonthReport } from "../types/planning";

/**
 * Spending trends: transactions by category over time, opened by period and category. Credit
 * utilization is on the Accounts page and recurring charges on Subscriptions.
 */
export function InsightsPage() {
  const month = monthOf(today());
  const { data } = useApi<MonthReport>(`/reports/month?month=${month}`);
  return (
    <section className="@container space-y-5">
      <div className="max-w-4xl">
        <h1 className="text-2xl font-semibold">Spending</h1>
        {data && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {spendingSentence(data, monthLabel(month, "long"))}
          </p>
        )}
        <HowThisWorks>
          <p>
            Where the money goes, by category over time. Click a point to open those transactions.
            Credit utilization is now on Accounts, and recurring charges under Subscriptions.
          </p>
        </HowThisWorks>
      </div>
      <div className="max-w-6xl">
        <CategoryExplorer />
      </div>
    </section>
  );
}
