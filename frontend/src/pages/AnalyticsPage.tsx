import { useMemo, useState } from "react";
import { NetWorthChart } from "../components/history/NetWorthChart";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { today } from "../lib/period";
import { formatDay } from "../lib/time";
import type { NetWorthHistory } from "../types/data";

const RANGES = [
  { value: "90", label: "3 months" },
  { value: "365", label: "12 months" },
  { value: "36500", label: "Everything" },
];

/** `YYYY-MM-DD` this many days before `day`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export function AnalyticsPage() {
  const [range, setRange] = useState("365");
  const [breakdown, setBreakdown] = useState(true);
  const from = useMemo(() => daysBefore(today(), Number(range)), [range]);
  const { data, error, loading } = useApi<NetWorthHistory>(
    `/analytics/net-worth-history?from=${from}`,
  );
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
  const rows = [...(data?.points ?? [])].reverse().slice(0, 60);

  return (
    <section className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Net worth over time</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Built only from balances the app actually recorded. Because the app is not always open,
            there can be gaps, and they are shown rather than filled in.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={breakdown}
              onChange={(e) => setBreakdown(e.target.checked)}
            />
            Show assets and debts
          </label>
          <select
            aria-label="How far back"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-600 dark:bg-slate-800"
          >
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}

      {data && data.points.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-600 dark:text-slate-300">
          {data.accountsTotal === 0
            ? "No accounts yet. Connect one on the Accounts page, or add an investment account by hand."
            : "No balances were recorded in this period. A point is added every time an account syncs or you update it by hand."}
        </div>
      )}

      {data && data.points.length > 0 && (
        <>
          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <NetWorthChart history={data} breakdown={breakdown} />
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="mb-3 text-lg font-semibold">Recorded balances</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th scope="col" className="pb-2 font-medium">
                      Day
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Net worth
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Assets
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Debts
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Accounts recorded
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.date} className="border-t border-slate-100 dark:border-slate-700">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {formatDay(p.date)}
                        {p.gapDays !== null && p.gapDays >= 7 && (
                          <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                            {p.gapDays} days after the previous
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {money(p.netWorthMinor)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{money(p.assetsMinor)}</td>
                      <td className="py-2 text-right tabular-nums">{money(p.liabilitiesMinor)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {p.accountsObserved} of {data.accountsTotal}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.points.length > rows.length && (
              <p className="mt-2 text-xs text-slate-500">
                Showing the latest {rows.length} of {data.points.length} recorded days.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
