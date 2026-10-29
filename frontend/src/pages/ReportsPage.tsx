import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import { formatDay } from "../lib/time";
import type { MonthReport } from "../types/planning";
import { Loading } from "../components/common/Loading";

/** The month-end report: how a month went, next to the month before. */
export function ReportsPage() {
  // The last whole month by default.
  const [month, setMonth] = useState(() => shiftMonth(monthOf(today()), -1));
  const { data, error, loading } = useApi<MonthReport>(`/reports/month?month=${month}`);
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
  const change = (now: number, before: number, goodWhenLower = false) => {
    const diff = now - before;
    if (diff === 0) return <span className="text-slate-500">same as before</span>;
    const good = goodWhenLower ? diff < 0 : diff > 0;
    return (
      <span className={good ? "text-green-700 dark:text-green-400" : "text-red-600"}>
        {diff > 0 ? "+" : "−"}
        {money(Math.abs(diff))} vs {monthLabel(shiftMonth(month, -1))}
      </span>
    );
  };

  return (
    <section className="@container max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Month report</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Income, spending, and what changed. Moves between your own accounts and card payments
            are left out.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth(shiftMonth(month, -1))}
            className="rounded border border-slate-300 px-3 py-1 dark:border-slate-600"
          >
            ‹
          </button>
          <span className="min-w-32 text-center font-medium">{monthLabel(month, "long")}</span>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setMonth(shiftMonth(month, 1))}
            className="rounded border border-slate-300 px-3 py-1 dark:border-slate-600"
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
      {!data && loading && <Loading />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card
              label="Income"
              value={money(data.incomeMinor)}
              sub={change(data.incomeMinor, data.previous.incomeMinor)}
            />
            <Card
              label="Spending"
              value={money(data.spendingMinor)}
              sub={change(data.spendingMinor, data.previous.spendingMinor, true)}
            />
            <Card
              label="Saved"
              value={money(data.savedMinor)}
              sub={
                data.savingsRatePercent === null ? (
                  <span className="text-slate-500">no income this month</span>
                ) : (
                  <span>{data.savingsRatePercent}% of income</span>
                )
              }
              warn={data.savedMinor < 0}
            />
            <Card
              label="Net worth change"
              value={data.netWorth.changeMinor === null ? "—" : money(data.netWorth.changeMinor)}
              sub={
                data.netWorth.endMinor === null ? (
                  <span className="text-slate-500">not enough history</span>
                ) : (
                  <span>now {money(data.netWorth.endMinor)}</span>
                )
              }
              warn={(data.netWorth.changeMinor ?? 0) < 0}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card label="Paid toward debt" value={money(data.debtPaidMinor)} />
            <Card label="Cashback earned" value={money(data.cashbackMinor)} />
            <Card
              label="Budgets"
              value={
                data.budgets.count === 0
                  ? "None set"
                  : `${data.budgets.count - data.budgets.overspent} of ${data.budgets.count} on track`
              }
              sub={
                data.budgets.count > 0 ? (
                  <span>
                    {money(data.budgets.spentMinor)} of {money(data.budgets.budgetedMinor)}
                  </span>
                ) : undefined
              }
              warn={data.budgets.overspent > 0}
            />
            <Card label="Transactions" value={String(data.transactionCount)} />
          </div>

          {/* Categories and the largest purchases side by side when the page has room. */}
          <div className="grid items-start gap-4 @min-[60rem]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <h2 className="mb-2 font-semibold">Spending by category</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">Category</th>
                    <th className="py-1 text-right font-medium">{monthLabel(month)}</th>
                    <th className="py-1 text-right font-medium">
                      {monthLabel(shiftMonth(month, -1))}
                    </th>
                    <th className="py-1 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {data.categories.map((c) => (
                    <tr key={c.label} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1">
                        <span
                          aria-hidden="true"
                          className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: c.color ?? "#94a3b8" }}
                        />
                        {c.label}
                      </td>
                      <td className="py-1 text-right tabular-nums">{money(c.spendingMinor)}</td>
                      <td className="py-1 text-right text-slate-500 tabular-nums">
                        {money(c.previousMinor)}
                      </td>
                      <td
                        className={`py-1 text-right tabular-nums ${c.changeMinor > 0 ? "text-red-600" : c.changeMinor < 0 ? "text-green-700 dark:text-green-400" : ""}`}
                      >
                        {c.changeMinor > 0 ? "+" : c.changeMinor < 0 ? "−" : ""}
                        {money(Math.abs(c.changeMinor))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <h2 className="mb-2 font-semibold">Largest purchases</h2>
              <ul className="space-y-1 text-sm">
                {data.largest.map((t) => (
                  <li key={t.id} className="flex justify-between gap-2">
                    <span>
                      {t.merchant}{" "}
                      <span className="text-xs text-slate-500">
                        {formatDay(t.date)} · {t.accountName}
                      </span>
                    </span>
                    <span className="tabular-nums">{money(t.amountMinor)}</span>
                  </li>
                ))}
                {data.largest.length === 0 && <li className="text-slate-500">No purchases.</li>}
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Card({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${warn ? "text-red-600" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-xs">{sub}</div>}
    </div>
  );
}
