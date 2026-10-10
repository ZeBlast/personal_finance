import { useId, useMemo, useState } from "react";
import { formatAxisMoney, formatMinor } from "../../lib/money";
import { today } from "../../lib/period";
import {
  inTodaysDollars,
  projectBalances,
  withdrawalPerYear,
  yearlyContributions,
} from "../../lib/retirement";
import type { TspContribution } from "../../lib/tsp";
import { LineChart } from "../charts/LineChart";
import { inputClass } from "./styles";

const SCENARIOS = [
  { key: "low", label: "Slow growth (4%)", rate: 0.04, color: "#f59e0b" },
  { key: "mid", label: "Middle (6%)", rate: 0.06, color: "#2563eb" },
  { key: "high", label: "Strong growth (8%)", rate: 0.08, color: "#16a34a" },
] as const;
const INFLATION = 0.025;
const STORE = "pf.retirement.ages";

function storedAges(): { age: string; retireAt: string } {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return JSON.parse(raw) as { age: string; retireAt: string };
  } catch {
    // Storage unavailable: start empty.
  }
  return { age: "", retireAt: "62" };
}

const money = (n: number) => formatMinor(n, "USD");

/**
 * Where the account might be by retirement: today's balance plus a year of the recurring
 * contributions (yours and the employer's) every year, at three steady growth rates. An
 * illustration, not a forecast.
 */
export function RetirementProjection({
  balanceMinor,
  contributions,
}: {
  balanceMinor: number;
  contributions: TspContribution[];
}) {
  const id = useId();
  const [ages, setAges] = useState(storedAges);
  const setAge = (change: Partial<typeof ages>) =>
    setAges((a) => {
      const next = { ...a, ...change };
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        // Not remembered; it still works for now.
      }
      return next;
    });
  const age = Number(ages.age);
  const retireAt = Number(ages.retireAt);
  const years =
    Number.isInteger(age) && Number.isInteger(retireAt) && age > 0 && retireAt > age
      ? Math.min(60, retireAt - age)
      : null;
  const yearly = yearlyContributions(contributions, today());

  const results = useMemo(() => {
    if (years === null) return null;
    return SCENARIOS.map((s) => ({
      ...s,
      balances: projectBalances({
        balanceMinor,
        yearlyContributionMinor: yearly,
        years,
        rate: s.rate,
      }),
    }));
  }, [years, balanceMinor, yearly]);

  const thisYear = new Date().getFullYear();
  const series = results?.map((r) => ({
    key: r.key,
    label: r.label,
    color: r.color,
    points: r.balances.map((value, y) => ({ date: `${thisYear + y}-01-01`, value })),
  }));

  return (
    <div className="space-y-3 text-sm">
      <div className="grid max-w-md grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${id}-age`} className="block font-medium">
            Your age now
          </label>
          <input
            id={`${id}-age`}
            inputMode="numeric"
            value={ages.age}
            placeholder="30"
            onChange={(e) => setAge({ age: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${id}-retire`} className="block font-medium">
            Retiring at
          </label>
          <input
            id={`${id}-retire`}
            inputMode="numeric"
            value={ages.retireAt}
            onChange={(e) => setAge({ retireAt: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>
      <p className="text-slate-600 dark:text-slate-300">
        Starting from {money(balanceMinor)}, with {money(yearly)} a year going in (your recurring
        contributions and the employer&apos;s match).
        {yearly === 0 && " Add a recurring contribution above to include what you put in."}
      </p>
      {years === null ? (
        <p className="text-slate-500">Enter your age to see the projection.</p>
      ) : (
        results && (
          <>
            <table className="w-full max-w-2xl">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1 font-medium">If it grows</th>
                  <th className="py-1 text-right font-medium">At {retireAt}</th>
                  <th className="py-1 text-right font-medium">In today&apos;s dollars</th>
                  <th className="py-1 text-right font-medium">About a year to spend</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const end = r.balances.at(-1)!;
                  const real = inTodaysDollars(end, years, INFLATION);
                  return (
                    <tr key={r.key} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1.5">
                        <span
                          aria-hidden="true"
                          className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: r.color }}
                        />
                        {r.label}
                      </td>
                      <td className="py-1.5 text-right font-medium tabular-nums">{money(end)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(real)}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {money(withdrawalPerYear(real))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {series && (
              <LineChart series={series} format={money} formatAxis={formatAxisMoney} dots={false} />
            )}
            <p className="text-xs text-slate-500">
              Steady growth every year, contributions kept as they are today, and {INFLATION * 100}%
              inflation for &quot;today&apos;s dollars&quot;. &quot;A year to spend&quot; uses the
              common 4% rule of thumb. Real returns go up and down; this is an illustration, not a
              promise.
            </p>
          </>
        )
      )}
    </div>
  );
}
