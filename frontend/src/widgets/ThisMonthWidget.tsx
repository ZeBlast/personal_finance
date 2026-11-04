import { useApi } from "../hooks/useApi";
import { sortCaps } from "../lib/caps";
import { formatMinor } from "../lib/money";
import { monthLabel, monthOf, today } from "../lib/period";
import { formatDay } from "../lib/time";
import type { Budget, BudgetMonth } from "../types/analytics";
import type { Settings } from "../types/api";
import type { DailyBrief } from "./DailyBriefWidget";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export interface CapReading {
  /** The cap's category and how it stands, such as "Dining out: Over by $12.00". */
  text: string;
  /** True when the cap is over its limit. */
  bad: boolean;
}

/** The cap closest to or over its limit, in words; null when there are no caps. Pure. */
export function worstCap(caps: Budget[], money: (minor: number) => string): CapReading | null {
  const worst = sortCaps(caps)[0];
  if (!worst) return null;
  const status =
    worst.status === "over"
      ? `Over by ${money(-worst.remainingMinor)}`
      : worst.status === "risk"
        ? "At risk"
        : worst.status === "full"
          ? "At its limit"
          : "On track";
  return { text: `${worst.categoryName}: ${status}`, bad: worst.status === "over" };
}

export default defineWidget({
  id: "this-month",
  title: "This month",
  description: "Whether you are on track this month: spending against your caps, and the next pay.",
  group: "Spending caps",
  defaultSize: { w: 12, h: 2 },
  minSize: { w: 4, h: 2 },
  order: 2,
  singleton: true,
  Component: function ThisMonth() {
    const day = today();
    const month = monthOf(day);
    const caps = useApi<BudgetMonth>(`/budgets?month=${month}&today=${day}`);
    // The next pay is a nice-to-have: a brief that fails to load never hides the caps.
    const brief = useApi<DailyBrief>("/brief?bufferMinor=0");
    // Amounts wait for the user's own currency, so dollars never flash up first.
    const settings = useApi<Settings>("/settings");
    const currency = settings.data?.currency;
    const money = (n: number) => (currency ? formatMinor(n, currency) : "");
    const data = caps.data;
    const worst = data ? worstCap(data.budgets, money) : null;
    const income = brief.data?.nextIncome ?? null;

    return (
      <WidgetState
        loading={caps.loading || settings.data === null}
        error={caps.error ?? settings.error}
        empty={data !== null && data.budgets.length === 0}
        emptyText={`No spending caps for ${monthLabel(month, "long")} yet, so there is nothing to be on track for.`}
        emptyAction={{ to: "/planning/budgets", label: "Set a cap" }}
      >
        {data && (
          <div className="@container h-full">
            <div className="grid gap-x-10 gap-y-2 @min-[44rem]:grid-cols-2">
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  This month, {monthLabel(month, "long")}
                </p>
                <p className="text-2xl font-semibold tracking-tight tabular-nums">
                  {money(data.totals.spentMinor)}{" "}
                  <span className="text-base font-normal text-slate-600 dark:text-slate-300">
                    of {money(data.totals.budgetedMinor)} in caps
                  </span>
                </p>
              </div>
              <div className="space-y-1 text-sm">
                {worst && (
                  <p
                    className={
                      worst.bad
                        ? "text-red-600 dark:text-red-400"
                        : "text-slate-600 dark:text-slate-300"
                    }
                  >
                    {worst.text}
                  </p>
                )}
                {income && (
                  <p className="text-slate-500 dark:text-slate-400">
                    Next income: {income.label}, {money(income.amountMinor)} on{" "}
                    {formatDay(income.date)}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </WidgetState>
    );
  },
});
