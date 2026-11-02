import { useState } from "react";
import { Loading } from "../components/common/Loading";
import { Select } from "../components/common/Select";
import { MerchantTrends } from "../components/views/MerchantTrends";
import { heatmapPath, SpendingHeatmap } from "../components/views/SpendingHeatmap";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { today } from "../lib/period";
import type { Summary } from "../types/analytics";

/** Habits that a monthly total hides: which days money goes, and to whom. */
export function PatternsPage() {
  const [weeks, setWeeks] = useState(52);
  const [months, setMonths] = useState(6);
  const end = today();
  const { data, error, loading } = useApi<Summary>(heatmapPath(end, weeks));
  const money = (n: number) => formatMinor(n, "USD");

  return (
    <section className="max-w-6xl space-y-8">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Spending patterns</h1>
          <label className="text-sm">
            How far back{" "}
            <Select
              value={weeks}
              onChange={(e) => setWeeks(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-600"
            >
              <option value={13}>3 months</option>
              <option value={26}>6 months</option>
              <option value={52}>1 year</option>
            </Select>
          </label>
        </div>
        <p className="mt-1 mb-4 text-sm text-slate-500 dark:text-slate-400">
          Each square is a day. Click one for its transactions.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {!data && loading && <Loading lines={4} />}
        {data && <SpendingHeatmap rows={data.rows} end={end} weeks={weeks} money={money} />}
      </div>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Merchant trends</h2>
          <label className="text-sm">
            Months to compare{" "}
            <Select
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-600"
            >
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </Select>
          </label>
        </div>
        <MerchantTrends months={months} />
      </div>
    </section>
  );
}
