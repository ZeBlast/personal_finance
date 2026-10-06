import { ProgressBar } from "../components/charts/ProgressBar";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import type { Overview } from "../types/analytics";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "credit-cards",
  title: "Credit cards",
  description: "Balance, credit limit and utilization of each card, with its latest limit change.",
  group: "Accounts",
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 3 },
  defaultEnabled: true,
  order: 30,
  Component: function CreditCards() {
    const { data, error, loading } = useApi<Overview>("/analytics/overview");
    const cards = data?.creditCards ?? [];
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && cards.length === 0}
        emptyText="No credit cards connected."
      >
        <ul className="space-y-4">
          {cards.map((card) => (
            <li key={card.accountId} className="space-y-1 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: card.color ?? "#94a3b8" }}
                  />
                  <span className="truncate font-medium">{card.name}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMinor(card.balanceMinor, data?.currency ?? "USD")}
                </span>
              </div>
              {card.limitMinor && card.balanceMinor !== null ? (
                <>
                  <ProgressBar
                    value={card.balanceMinor}
                    max={card.limitMinor}
                    label={`${card.name} utilization`}
                    color={card.color}
                  />
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>
                      {card.utilizationPercent}% of{" "}
                      {formatMinor(card.limitMinor, data?.currency ?? "USD")}
                    </span>
                    {card.lastLimitChange && (
                      <span>
                        limit {card.lastLimitChange.changeMinor > 0 ? "up" : "down"}{" "}
                        {formatMinor(
                          Math.abs(card.lastLimitChange.changeMinor),
                          data?.currency ?? "USD",
                        )}{" "}
                        on {formatDay(card.lastLimitChange.effectiveDate)}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-500">
                  No credit limit recorded. Add one on the Accounts page to see utilization.
                </p>
              )}
            </li>
          ))}
        </ul>
      </WidgetState>
    );
  },
});
