import { AlertTriangle, Check, CircleDot } from "lucide-react";
import { AnimatedNumber } from "../components/common/AnimatedNumber";
import { Link } from "react-router-dom";
import { useBadges } from "../components/layout/NavBadge";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { monthOf, today } from "../lib/period";
import { formatDay } from "../lib/time";
import { attentionItems } from "../lib/views";
import type { BudgetMonth } from "../types/analytics";
import type { Forecast } from "../types/planning";
import type { DailyBrief } from "./DailyBriefWidget";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "home-summary",
  title: "Where you stand",
  description:
    "What is safe to spend, the next low point for your cash, and anything that needs you.",
  group: "Planning",
  defaultSize: { w: 12, h: 2 },
  minSize: { w: 4, h: 2 },
  order: 1,
  singleton: true,
  defaultConfig: { buffer: 0 },
  configFields: [
    {
      key: "buffer",
      label: "Always keep at least (dollars)",
      help: "Left out of what is safe to spend.",
      type: "number",
      min: 0,
      max: 1_000_000,
      step: 50,
    },
  ],
  Component: function HomeSummary({ config }) {
    const day = today();
    const bufferMinor = Math.round(Number(config.buffer) * 100);
    const brief = useApi<DailyBrief>(`/brief?bufferMinor=${bufferMinor}`);
    const forecast = useApi<Forecast>("/forecast?days=60");
    const caps = useApi<BudgetMonth>(`/budgets?month=${monthOf(day)}&today=${day}`);
    const badges = useBadges();
    const b = brief.data;
    const f = forecast.data;
    const money = (n: number) => formatMinor(n, b?.currency ?? "USD");
    const items = attentionItems({
      forecast: f,
      brief: b,
      capsOver: caps.data?.budgets.filter((c) => c.status === "over").length ?? 0,
      capsAtRisk: caps.data?.budgets.filter((c) => c.status === "risk").length ?? 0,
      toReview: badges["/transactions/review"]?.count ?? 0,
      money,
    });
    const next = f?.days
      .flatMap((d) =>
        d.events.filter((e) => e.amountMinor < 0).map((e) => ({ ...e, date: d.date })),
      )
      .at(0);

    return (
      <WidgetState
        loading={brief.loading}
        error={brief.error}
        empty={b !== null && b.accountsCounted === 0}
        emptyText="Add a checking or savings account to see where you stand."
        emptyAction={{ to: "/accounts", label: "Add an account" }}
      >
        {b && (
          <div className="@container h-full">
            <div className="grid gap-x-10 gap-y-3 @min-[44rem]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div>
                <p
                  className={`text-4xl font-semibold tracking-tight tabular-nums ${b.shortMinor > 0 ? "text-red-700 dark:text-red-400" : ""}`}
                >
                  <AnimatedNumber value={b.safeToSpendMinor} format={money} />
                </p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  safe to spend until {formatDay(b.until)}
                  {b.nextIncome
                    ? `, when ${b.nextIncome.label} brings ${money(b.nextIncome.amountMinor)}`
                    : ", with no income expected before then"}
                  {b.perDayMinor !== null && `. About ${money(b.perDayMinor)} a day.`}
                </p>
                {f && (
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {money(f.startBalanceMinor)} in the bank, lowest {money(f.lowest.balanceMinor)}{" "}
                    on {formatDay(f.lowest.date)}
                    {next &&
                      `. Next out: ${next.label}, ${money(next.amountMinor)} on ${formatDay(next.date)}`}
                    .
                  </p>
                )}
              </div>
              <div>
                {items.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                    <Check
                      aria-hidden="true"
                      className="h-4 w-4 text-green-700 dark:text-green-400"
                    />
                    Nothing needs you right now.
                  </p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {items.slice(0, 4).map((item) => (
                      <li key={item.text}>
                        <Link to={item.to} className="flex items-center gap-2 hover:underline">
                          {item.tone === "warn" ? (
                            <AlertTriangle
                              aria-hidden="true"
                              className="h-4 w-4 shrink-0 text-red-700 dark:text-red-400"
                            />
                          ) : (
                            <CircleDot
                              aria-hidden="true"
                              className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400"
                            />
                          )}
                          {item.text}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </WidgetState>
    );
  },
});
