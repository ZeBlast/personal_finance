import { useState } from "react";
import { BarList } from "../components/charts/BarList";
import { Loading } from "../components/common/Loading";
import { YearMonthsTable, type YearMonthRow } from "../components/views/YearMonthsTable";
import { useApi } from "../hooks/useApi";
import { useCategories } from "../hooks/useCategories";
import { childNames, rolledUpTitle } from "../lib/categoryRollup";
import { formatMinor } from "../lib/money";
import { monthLabel, today } from "../lib/period";

export interface YearReport {
  year: number;
  currency: string;
  months: YearMonthRow[];
  incomeMinor: number;
  spendingMinor: number;
  savedMinor: number;
  savingsRatePercent: number | null;
  highestMonth: string | null;
  lowestMonth: string | null;
  capsHeld: number;
  capsCount: number;
  categories: Array<{
    label: string;
    color: string | null;
    spendingMinor: number;
    sharePercent: number;
  }>;
  merchants: Array<{ label: string; spendingMinor: number }>;
  netWorth: { startMinor: number | null; endMinor: number | null; changeMinor: number | null };
}

/** The year's story in a sentence, from its own figures. Pure. */
export function yearSentence(r: YearReport, money: (minor: number) => string): string {
  const parts = [`${money(r.incomeMinor)} came in and ${money(r.spendingMinor)} went out`];
  if (r.savingsRatePercent !== null) {
    parts.push(
      r.savedMinor >= 0
        ? `saving ${r.savingsRatePercent}% of income`
        : `${money(-r.savedMinor)} more than came in`,
    );
  }
  if (r.netWorth.changeMinor !== null) {
    parts.push(
      `net worth ${r.netWorth.changeMinor >= 0 ? "up" : "down"} ${money(Math.abs(r.netWorth.changeMinor))}`,
    );
  }
  return `${parts.join(", ")}.`;
}

export function YearPage() {
  const day = today();
  const [year, setYear] = useState(Number(day.slice(0, 4)));
  const { data, error, loading } = useApi<YearReport>(`/reports/year?year=${year}&today=${day}`);
  const { categories } = useCategories();
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");

  return (
    <section className="@container max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Year in review</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {data ? yearSentence(data, money) : "How the year went, month by month."}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous year"
            onClick={() => setYear(year - 1)}
            className="rounded border border-slate-300 px-3 py-1 dark:border-slate-600"
          >
            ‹
          </button>
          <span className="min-w-20 text-center font-medium" aria-live="polite">
            {year}
          </span>
          <button
            type="button"
            aria-label="Next year"
            disabled={year >= Number(day.slice(0, 4))}
            onClick={() => setYear(year + 1)}
            className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40 dark:border-slate-600"
          >
            ›
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {!data && loading && <Loading lines={8} />}
      {data && (
        <>
          <YearMonthsTable
            months={data.months}
            money={money}
            highest={data.highestMonth}
            lowest={data.lowestMonth}
          />
          {data.capsCount > 0 && (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Spending caps held {data.capsHeld} of {data.capsCount} times this year.
            </p>
          )}
          <div className="grid gap-8 @min-[48rem]:grid-cols-2">
            <div>
              <h2 className="mb-2 font-semibold">Where it went, by parent category</h2>
              <BarList
                rows={data.categories.map((c) => ({
                  key: c.label,
                  label: c.label,
                  value: c.spendingMinor,
                  color: c.color,
                  title: rolledUpTitle(c.label, childNames(categories ?? [], c.label)),
                }))}
                format={money}
              />
            </div>
            <div>
              <h2 className="mb-2 font-semibold">Biggest merchants</h2>
              <ul className="text-sm">
                {data.merchants.map((m) => (
                  <li
                    key={m.label}
                    className="flex justify-between gap-3 border-t border-slate-100 py-1 dark:border-slate-800"
                  >
                    <span className="truncate">{m.label}</span>
                    <span className="tabular-nums">{money(m.spendingMinor)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {data.highestMonth && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Highest and lowest are whole months only: {monthLabel(data.highestMonth, "long")} and{" "}
              {data.lowestMonth ? monthLabel(data.lowestMonth, "long") : "none"}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
