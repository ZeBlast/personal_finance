import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import type { PortfolioOverview } from "../types/investments";
import { investmentAccountField } from "./fields";
import { Stat, WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export default defineWidget({
  id: "portfolio-value",
  title: "Portfolio value",
  description:
    "What your investment accounts are worth, with a gain figure where the cost is known.",
  group: "Accounts",
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 3 },
  order: 25,
  defaultConfig: { accountId: "" },
  configFields: [investmentAccountField],
  Component: function PortfolioValue({ config }) {
    const { data, error, loading } = useApi<PortfolioOverview>(
      `/investments/overview${config.accountId ? `?accountId=${config.accountId}` : ""}`,
    );
    const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
    const basis = data?.costBasis ?? null;

    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.accounts.length === 0}
        emptyText="No investment accounts yet. Add one on the Investments page."
      >
        <div className="space-y-3">
          <Stat
            label="Total value"
            value={money(data?.totalValueMinor ?? 0)}
            note={
              basis ? (
                <span>
                  {basis.complete
                    ? "Gain "
                    : `Gain on the ${money(basis.knownValueMinor)} with a known cost: `}
                  <span
                    className={
                      basis.gainMinor >= 0
                        ? "text-green-700 dark:text-green-400"
                        : "text-red-600 dark:text-red-400"
                    }
                  >
                    {basis.gainMinor >= 0 ? "+" : "−"}
                    {money(Math.abs(basis.gainMinor))}
                  </span>
                </span>
              ) : (
                "Gain unknown: no cost basis recorded."
              )
            }
          />
          <ul className="space-y-1">
            {(data?.accounts ?? []).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: a.color ?? "#94a3b8" }}
                  />
                  <span className="truncate">{a.name}</span>
                  {a.isManual && <span className="text-xs text-slate-500">by hand</span>}
                </span>
                <span className="shrink-0 tabular-nums">{money(a.valueMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      </WidgetState>
    );
  },
});
