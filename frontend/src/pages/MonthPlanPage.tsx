import { useState } from "react";
import { Link } from "react-router-dom";
import { Loading } from "../components/common/Loading";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { shiftMonth, today } from "../lib/period";
import { leftLine } from "../lib/planTools";
import { formatDay } from "../lib/time";
import type { MonthPlan, PlanKind } from "../types/planTools";

/** The sections of a plan, in order, with where each is changed. */
const SECTIONS: Array<{ kind: PlanKind; title: string; link?: { to: string; label: string } }> = [
  { kind: "income", title: "Coming in", link: { to: "/planning/paychecks", label: "Paychecks" } },
  {
    kind: "bill",
    title: "Bills and subscriptions",
    link: { to: "/planning/subscriptions", label: "Subscriptions" },
  },
  { kind: "cap", title: "Spending caps", link: { to: "/planning/budgets", label: "Change caps" } },
  {
    kind: "usual",
    title: "Usual spending with no cap",
    link: { to: "/planning/budgets", label: "Set a cap" },
  },
  { kind: "goal", title: "Saving for goals", link: { to: "/planning/goals", label: "Goals" } },
  {
    kind: "debt",
    title: "Extra toward debt",
    link: { to: "/planning/debt", label: "Debt payoff" },
  },
];

const monthName = (month: string): string =>
  new Date(`${month}-15T12:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" });

/** Planning > Month plan: a month's income next to everything it has to cover. */
export function MonthPlanPage() {
  const thisMonth = today().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const { data, error, loading } = useApi<MonthPlan>(`/month-plan?month=${month}&today=${today()}`);
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
  const left = data ? leftLine(data, money) : null;
  const stepButton =
    "rounded-md border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-800";

  return (
    <section className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Month plan</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {left?.text ?? "What comes in this month, and everything it has to cover."}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className={stepButton}
          aria-label="Previous month"
          disabled={month <= shiftMonth(thisMonth, -12)}
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ‹
        </button>
        <span className="min-w-36 text-center font-medium">{monthName(month)}</span>
        <button
          type="button"
          className={stepButton}
          aria-label="Next month"
          disabled={month >= shiftMonth(thisMonth, 6)}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ›
        </button>
        {month !== thisMonth && (
          <button
            type="button"
            className="text-sm text-blue-700 hover:underline dark:text-blue-400"
            onClick={() => setMonth(thisMonth)}
          >
            This month
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {loading && !data && <Loading lines={6} />}
      {data && left && (
        <>
          <div className="flex flex-wrap items-end gap-6">
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400">Left to plan</div>
              <div
                className={`text-3xl font-semibold tabular-nums ${
                  left.tone === "short" ? "text-red-600 dark:text-red-400" : ""
                }`}
              >
                {money(data.leftMinor)}
              </div>
            </div>
            {data.actual && (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                So far: {money(data.actual.incomeMinor)} in, {money(data.actual.spendingMinor)}{" "}
                spent, through {formatDay(data.actual.through)}.
              </p>
            )}
          </div>

          <div className="space-y-3">
            {SECTIONS.map((section) => {
              const lines = data.lines.filter((l) => l.kind === section.kind);
              if (lines.length === 0) return null;
              return (
                <div
                  key={section.kind}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="font-medium">
                      {section.title}
                      {section.link && (
                        <Link
                          to={section.link.to}
                          className="ml-2 text-xs font-normal text-blue-700 hover:underline dark:text-blue-400"
                        >
                          {section.link.label}
                        </Link>
                      )}
                    </h2>
                    <span className="font-semibold tabular-nums">
                      {section.kind === "income" ? "" : "−"}
                      {money(data.totals[section.kind])}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {lines.map((l, i) => (
                      <li key={`${l.label}-${i}`} className="flex justify-between gap-2">
                        <span className="text-slate-700 dark:text-slate-200">
                          {l.label}
                          {l.note && (
                            <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                              ({l.note})
                            </span>
                          )}
                        </span>
                        <span className="tabular-nums text-slate-600 dark:text-slate-300">
                          {money(l.amountMinor)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Bills are your recurring and expected payments; one in a category with a cap is counted
            inside the cap. Usual spending is the average of recent complete months.
          </p>
        </>
      )}
    </section>
  );
}
