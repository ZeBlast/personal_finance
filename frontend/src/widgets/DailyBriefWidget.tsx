import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export interface DailyBrief {
  currency: string;
  today: string;
  cashMinor: number;
  accountsCounted: number;
  nextIncome: { date: string; label: string; amountMinor: number } | null;
  until: string;
  obligations: Array<{ label: string; date: string; amountMinor: number; source: string }>;
  obligationsMinor: number;
  lowest: { date: string; balanceMinor: number };
  reservedMinor: number;
  reservedFor: Array<{ accountName: string; amountMinor: number }>;
  bufferMinor: number;
  safeToSpendMinor: number;
  shortMinor: number;
  perDayMinor: number | null;
  spentYesterdayMinor: number;
  spentThisMonthMinor: number;
  /** Bank accounts whose balance may be out of date. */
  staleAccounts?: Array<{ name: string; updatedAt: string | null; needsSignIn: boolean }>;
}

/** A warning when the starting cash rests on old balances, or null when they are fresh. Pure. */
export function freshnessWarning(b: DailyBrief): string | null {
  const stale = b.staleAccounts ?? [];
  if (stale.length === 0) return null;
  const signIn = stale.filter((a) => a.needsSignIn).map((a) => a.name);
  if (signIn.length > 0) {
    return `${signIn.join(", ")} ${signIn.length === 1 ? "needs" : "need"} signing in again, so this uses an old balance.`;
  }
  return `${stale.map((a) => a.name).join(", ")} ${stale.length === 1 ? "has" : "have"} not synced in over a day: sync for an up-to-date figure.`;
}

export interface BriefStep {
  label: string;
  amountMinor: number;
  /** Smaller print under the line: what it is made of. */
  note?: string;
}

/** How safe-to-spend is worked out, line by line, so it can be checked. Pure. */
export function briefSteps(b: DailyBrief): BriefStep[] {
  const money = (n: number) => formatMinor(n, b.currency);
  const steps: BriefStep[] = [
    {
      label: "Cash in the bank now",
      amountMinor: b.cashMinor,
      note: `${b.accountsCounted} account${b.accountsCounted === 1 ? "" : "s"}`,
    },
  ];
  if (b.obligations.length > 0) {
    steps.push({
      label: `Going out by ${formatDay(b.until)}`,
      amountMinor: b.obligationsMinor,
      note: b.obligations.map((o) => `${o.label} ${money(-o.amountMinor)}`).join(" · "),
    });
  }
  if (b.lowest.balanceMinor !== b.cashMinor + b.obligationsMinor) {
    steps.push({
      label: `Lowest point, ${formatDay(b.lowest.date)}`,
      amountMinor: b.lowest.balanceMinor,
      note: "Money arriving after the lowest day does not help before it.",
    });
  }
  if (b.reservedMinor > 0) {
    steps.push({
      label: "Held for goals",
      amountMinor: -b.reservedMinor,
      note: b.reservedFor.map((r) => `${r.accountName} ${money(r.amountMinor)}`).join(" · "),
    });
  }
  if (b.bufferMinor > 0) steps.push({ label: "Buffer you keep", amountMinor: -b.bufferMinor });
  return steps;
}

export default defineWidget({
  id: "daily-brief",
  title: "Safe to spend",
  description:
    "What you can spend until money next comes in, after bills, goals and a buffer, with how it is worked out.",
  group: "Spending",
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 4 },
  order: 5,
  singleton: true,
  defaultConfig: { buffer: 0 },
  configFields: [
    {
      key: "buffer",
      label: "Always keep at least (dollars)",
      type: "number",
      min: 0,
      max: 1_000_000,
      step: 50,
    },
  ],
  Component: function DailyBriefCard({ config }) {
    const bufferMinor = Math.round(Number(config.buffer) * 100);
    const { data, error, loading } = useApi<DailyBrief>(`/brief?bufferMinor=${bufferMinor}`);
    const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.accountsCounted === 0}
        emptyText="Add a checking or savings account to see what is safe to spend."
      >
        {data && (
          <div className="space-y-2 text-sm">
            <div>
              <div
                className={`text-2xl font-semibold tabular-nums ${data.shortMinor > 0 ? "text-red-600 dark:text-red-400" : ""}`}
              >
                {money(data.safeToSpendMinor)}
              </div>
              <p className="text-xs text-slate-500">
                until {formatDay(data.until)}
                {data.nextIncome
                  ? `, before ${data.nextIncome.label} (${money(data.nextIncome.amountMinor)})`
                  : " (no income expected soon)"}
                {data.perDayMinor !== null && ` · about ${money(data.perDayMinor)} a day`}
              </p>
              {data.shortMinor > 0 && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {money(data.shortMinor)} short of your goals and buffer at the lowest point.
                </p>
              )}
            </div>
            {freshnessWarning(data) && (
              <p
                role="status"
                className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {freshnessWarning(data)}
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-blue-600">
                How this is worked out
              </summary>
              <ul className="mt-1 space-y-1">
                {briefSteps(data).map((s) => (
                  <li key={s.label}>
                    <div className="flex justify-between gap-2">
                      <span>{s.label}</span>
                      <span className="tabular-nums">{money(s.amountMinor)}</span>
                    </div>
                    {s.note && <div className="text-xs text-slate-500">{s.note}</div>}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">
                Card purchases count once, when their bill is paid.
              </p>
            </details>
            <p className="text-xs text-slate-500">
              Spent yesterday {money(data.spentYesterdayMinor)} · this month{" "}
              {money(data.spentThisMonthMinor)}
            </p>
          </div>
        )}
      </WidgetState>
    );
  },
});
