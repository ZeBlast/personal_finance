import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";

export interface ReturnResult {
  startDate: string;
  endDate: string;
  days: number;
  startValueMinor: number;
  endValueMinor: number;
  netContributedMinor: number;
  gainMinor: number;
  returnRate: number | null;
  annualRate: number | null;
}

export interface PortfolioReturns {
  periods: Array<{
    key: "ytd" | "year" | "all";
    label: string;
    from: string;
    to: string;
    combined: ReturnResult | null;
    accounts: Array<{ accountId: number; name: string; result: ReturnResult | null }>;
  }>;
  withoutHistory: string[];
}

/** A rate as a signed percent with one decimal: "+5.4%", "−2.0%", or "—". Pure. */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  const pct = Math.round(rate * 1000) / 10;
  if (pct === 0) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

const tone = (rate: number | null) =>
  rate === null || rate === 0
    ? ""
    : rate > 0
      ? "text-green-700 dark:text-green-400"
      : "text-red-600 dark:text-red-400";

/** How the investments did, with the money put in taken out: per period, and per account. */
export function ReturnsCard() {
  const { data, error } = useApi<PortfolioReturns>("/investments/returns");
  const money = (n: number) => formatMinor(n, "USD");
  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {error}
      </p>
    );
  }
  if (!data || data.periods.every((p) => p.combined === null)) return null;
  const all = data.periods.find((p) => p.key === "all");

  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <h2 className="text-lg font-semibold">Returns</h2>
      <p className="mb-3 text-xs text-slate-500">
        What the investments made, with the money you put in (or took out) left out, so a
        contribution does not look like growth. Money-weighted (Modified Dietz).
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-1 font-medium">Period</th>
              <th className="py-1 text-right font-medium">Return</th>
              <th className="py-1 text-right font-medium">A year</th>
              <th className="py-1 text-right font-medium">Gained</th>
              <th className="py-1 text-right font-medium">Put in, net</th>
              <th className="py-1 text-right font-medium">Value now</th>
            </tr>
          </thead>
          <tbody>
            {data.periods.map((p) =>
              p.combined ? (
                <tr key={p.key} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5">
                    {p.label}
                    <span className="block text-xs text-slate-500">from {formatDay(p.from)}</span>
                  </td>
                  <td
                    className={`py-1.5 text-right font-semibold tabular-nums ${tone(p.combined.returnRate)}`}
                  >
                    {formatRate(p.combined.returnRate)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {p.combined.annualRate === null ? "—" : formatRate(p.combined.annualRate)}
                  </td>
                  <td className={`py-1.5 text-right tabular-nums ${tone(p.combined.gainMinor)}`}>
                    {money(p.combined.gainMinor)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {money(p.combined.netContributedMinor)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {money(p.combined.endValueMinor)}
                  </td>
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      </div>
      {all && all.accounts.length > 1 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-xs text-blue-600">By account</summary>
          <ul className="mt-1 space-y-1">
            {all.accounts.map((a) => (
              <li key={a.accountId} className="flex justify-between gap-2">
                <span>{a.name}</span>
                <span className="text-slate-500">
                  <span className={`font-medium ${tone(a.result?.returnRate ?? null)}`}>
                    {formatRate(a.result?.returnRate ?? null)}
                  </span>
                  {a.result?.annualRate != null && ` (${formatRate(a.result.annualRate)} a year)`}
                  {a.result && ` · ${money(a.result.gainMinor)} gained`}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-slate-500">Since each account's records began.</p>
        </details>
      )}
      {data.withoutHistory.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Not counted until they have a value from before today: {data.withoutHistory.join(", ")}.
        </p>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Only as complete as the history: contributions the bank or file did not report count as
        growth, and an account that started during a period counts its first value as put in.
      </p>
    </div>
  );
}
