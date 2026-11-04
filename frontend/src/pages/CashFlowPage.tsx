import { useState } from "react";
import { Loading } from "../components/common/Loading";
import { cashFlowPath, CashFlowMap } from "../components/views/CashFlowMap";
import { useApi } from "../hooks/useApi";
import { useCategories } from "../hooks/useCategories";
import { childNames } from "../lib/categoryRollup";
import { formatMinor } from "../lib/money";
import { monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import { cashFlowModel } from "../lib/views";
import type { Summary } from "../types/analytics";

/** One month's money as a single picture: where it came from and where it went. */
export function CashFlowPage() {
  const [month, setMonth] = useState(() => shiftMonth(monthOf(today()), -1));
  const { data, error, loading } = useApi<Summary>(cashFlowPath(month));
  const { categories } = useCategories(true);
  const money = (n: number) => formatMinor(n, "USD");
  const model = data ? cashFlowModel(data.rows) : null;
  const left = model ? model.incomeMinor - model.spendingMinor : 0;

  return (
    <section className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Cash flow</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {model
              ? `${money(model.incomeMinor)} came in and ${money(model.spendingMinor)} went out, ${
                  left >= 0 ? `leaving ${money(left)}` : `${money(-left)} more than came in`
                }.`
              : "Where the month's money came from and where it went."}
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
          <span className="min-w-32 text-center font-medium" aria-live="polite">
            {monthLabel(month, "long")}
          </span>
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
      {!data && loading && <Loading lines={6} />}
      {data && (
        <CashFlowMap
          rows={data.rows}
          month={month}
          money={money}
          height={460}
          childrenOf={(label) => childNames(categories ?? [], label)}
        />
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Categories are shown by parent category, with their subcategories added together. Moves
        between your own accounts and card payments are left out. Refunds reduce a category. Click a
        category for its transactions.
      </p>
    </section>
  );
}
