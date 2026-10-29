import { useState } from "react";
import { NetWorthSeriesChart } from "../components/history/NetWorthSeriesChart";
import { useApi } from "../hooks/useApi";
import { basisText, periodLabel, seriesPath } from "../lib/networthSeries";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import type { Granularity, NetWorthSeries } from "../types/data";
import { Select } from "../components/common/Select";
import { Loading } from "../components/common/Loading";

const RANGES = [
  { value: "30", label: "1 month" },
  { value: "90", label: "3 months" },
  { value: "365", label: "12 months" },
  { value: "36500", label: "Everything" },
];

const GRANULARITIES: Array<{ value: Granularity; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const monthName = (day: string): string => {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

export function AnalyticsPage() {
  const [range, setRange] = useState("365");
  const [granularity, setGranularity] = useState<Granularity>("week");
  const [breakdown, setBreakdown] = useState(true);
  const { data, error, loading } = useApi<NetWorthSeries>(seriesPath(granularity, Number(range)));
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
  const rows = [...(data?.points ?? [])].reverse().slice(0, 60);
  const cappedDaily = granularity === "day" && Number(range) > 1000;

  return (
    <section className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Net worth over time</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Your net worth at the end of each day, week, or month, worked out from your
            accounts&apos; recorded balances and their transactions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div
            role="group"
            aria-label="One point per"
            className="flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-600"
          >
            {GRANULARITIES.map((g) => (
              <button
                key={g.value}
                type="button"
                aria-pressed={granularity === g.value}
                onClick={() => setGranularity(g.value)}
                className={`px-3 py-2 ${
                  granularity === g.value
                    ? "bg-blue-600 font-medium text-white"
                    : "hover:bg-slate-100 dark:hover:bg-slate-700"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={breakdown}
              onChange={(e) => setBreakdown(e.target.checked)}
            />
            Show assets and debts
          </label>
          <Select
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
          </Select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <Loading />}
      {cappedDaily && (
        <p className="text-sm text-slate-500">
          A daily view shows the latest 1,000 days. Choose Week or Month to see further back.
        </p>
      )}

      {data && data.points.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-600 dark:text-slate-300">
          {data.accountsTotal === 0
            ? "No accounts yet. Connect one on the Accounts page, or add an account by hand."
            : "No balances are known for this period yet. They appear once an account has synced or you have updated it by hand."}
        </div>
      )}

      {data && data.points.length > 0 && (
        <>
          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <NetWorthSeriesChart series={data} breakdown={breakdown} />
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="mb-3 text-lg font-semibold">By {granularity}, newest first</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th scope="col" className="pb-2 font-medium">
                      {granularity === "day" ? "Day" : granularity === "week" ? "Week" : "Month"}
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Net worth
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Change
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Assets
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      Debts
                    </th>
                    <th scope="col" className="pb-2 pl-3 font-medium">
                      Based on
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.date} className="border-t border-slate-100 dark:border-slate-700">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {periodLabel(granularity, p, formatDay, monthName)}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {money(p.netWorthMinor)}
                      </td>
                      <td
                        className={`py-2 text-right tabular-nums ${
                          p.changeMinor === null || p.changeMinor === 0
                            ? "text-slate-500"
                            : p.changeMinor > 0
                              ? "text-green-700 dark:text-green-400"
                              : "text-red-700 dark:text-red-400"
                        }`}
                      >
                        {p.changeMinor === null
                          ? "—"
                          : `${p.changeMinor > 0 ? "+" : p.changeMinor < 0 ? "−" : ""}${money(Math.abs(p.changeMinor))}`}
                      </td>
                      <td className="py-2 text-right tabular-nums">{money(p.assetsMinor)}</td>
                      <td className="py-2 text-right tabular-nums">{money(p.liabilitiesMinor)}</td>
                      <td className="py-2 pl-3 text-xs text-slate-500">{basisText(p.accounts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.points.length > rows.length && (
              <p className="mt-2 text-xs text-slate-500">
                Showing the latest {rows.length} of {data.points.length}.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
