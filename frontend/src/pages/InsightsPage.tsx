import { CategoryExplorer } from "../components/insights/CategoryExplorer";

/**
 * Spending trends: transactions by category over time, opened by period and category. Credit
 * utilization is on the Accounts page and recurring charges on Subscriptions.
 */
export function InsightsPage() {
  return (
    <section className="@container space-y-5">
      <div className="max-w-4xl">
        <h1 className="text-2xl font-semibold">Spending</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Where the money goes, by category over time. Click a point to open those transactions.
          Credit utilization is now on Accounts, and recurring charges under Subscriptions.
        </p>
      </div>
      <div className="max-w-6xl">
        <CategoryExplorer />
      </div>
    </section>
  );
}
