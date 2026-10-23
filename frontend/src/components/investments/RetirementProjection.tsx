import { useId, useMemo, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatAxisMoney, formatMinor, parseMoneyToMinor } from "../../lib/money";
import { today } from "../../lib/period";
import {
  chanceOfReaching,
  inTodaysDollars,
  simulateRange,
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
  accountId,
}: {
  balanceMinor: number;
  contributions: TspContribution[];
  /** The TSP account, for the range built from its funds' real years. */
  accountId?: number;
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
            {accountId !== undefined && (
              <HistoryRange
                accountId={accountId}
                balanceMinor={balanceMinor}
                yearlyMinor={yearly}
                years={years}
                retireAt={retireAt}
              />
            )}
          </>
        )
      )}
    </div>
  );
}

interface FundOutlook {
  mix: Array<{ symbol: string; name: string; share: number }>;
  years: Array<{ year: number; rate: number }>;
  standIns: Array<{ symbol: string; by: string; years: number[] }>;
  unpriced: string[];
  needsHistory: boolean;
}

/** The first day the TSP's share prices go back to. */
const PRICES_FROM = "2003-06-01";

/**
 * A range instead of three steady rates: thousands of futures, each year's growth drawn from a
 * real year of the account's own fund mix (from the TSP's share prices on file).
 */
function HistoryRange({
  accountId,
  balanceMinor,
  yearlyMinor,
  years,
  retireAt,
}: {
  accountId: number;
  balanceMinor: number;
  yearlyMinor: number;
  years: number;
  retireAt: number;
}) {
  const id = useId();
  const outlook = useApi<FundOutlook>(`/accounts/${accountId}/tsp/outlook`);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = outlook.data?.years.map((y) => y.rate) ?? [];
  const range = useMemo(
    () =>
      history.length >= 5
        ? simulateRange({ balanceMinor, yearlyContributionMinor: yearlyMinor, years, history })
        : null,
    // The history is a new array on each load: its values (as text) decide when to work it out again.
    [JSON.stringify(history), balanceMinor, yearlyMinor, years],
  );
  const goalMinor = parseMoneyToMinor(goal, "USD");

  async function download(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api("/tsp/prices/fetch", {
        method: "POST",
        body: JSON.stringify({ since: PRICES_FROM }),
      });
      outlook.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not download the price history."));
    } finally {
      setBusy(false);
    }
  }

  const thisYear = new Date().getFullYear();
  const o = outlook.data;
  return (
    <div className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
      <h4 className="font-medium">A range from the funds&apos; real years</h4>
      {o && o.needsHistory && (
        <p className="text-slate-600 dark:text-slate-300">
          {o.years.length === 0 ? "No" : `Only ${o.years.length}`} whole years of fund prices are on
          file. Download the TSP&apos;s share prices back to 2003 for a range built from about 20
          real years, 2008 included.{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => void download()}
            className="rounded border border-slate-300 px-2 py-0.5 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700"
          >
            {busy ? "Downloading..." : "Download price history"}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {o && range && (
        <>
          <p className="text-slate-600 dark:text-slate-300">
            2,000 possible futures, each year&apos;s growth taken from a real year (
            {o.years[0]!.year}–{o.years.at(-1)!.year}) of your current mix:{" "}
            {o.mix
              .map((m) => `${m.name.replace(/^TSP /, "")} ${Math.round(m.share * 100)}%`)
              .join(", ")}
            .
          </p>
          <table className="w-full max-w-2xl">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 font-medium">How it went</th>
                <th className="py-1 text-right font-medium">At {retireAt}</th>
                <th className="py-1 text-right font-medium">In today&apos;s dollars</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["A bad run (1 in 10 do worse)", range.low.at(-1)!, "#f59e0b"],
                  ["Typical (half do better)", range.middle.at(-1)!, "#2563eb"],
                  ["A good run (1 in 10 do better)", range.high.at(-1)!, "#16a34a"],
                ] as const
              ).map(([label, end, color]) => (
                <tr key={label} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5">
                    <span
                      aria-hidden="true"
                      className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {label}
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums">{money(end)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {money(inTodaysDollars(end, years, INFLATION))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <LineChart
            series={[
              { key: "low", label: "Bad run", color: "#f59e0b", values: range.low },
              { key: "mid", label: "Typical", color: "#2563eb", values: range.middle },
              { key: "high", label: "Good run", color: "#16a34a", values: range.high },
            ].map((s) => ({
              key: s.key,
              label: s.label,
              color: s.color,
              points: s.values.map((value, y) => ({ date: `${thisYear + y}-01-01`, value })),
            }))}
            format={money}
            formatAxis={formatAxisMoney}
            dots={false}
          />
          <label htmlFor={`${id}-goal`} className="flex flex-wrap items-center gap-2">
            Chance of having at least
            <input
              id={`${id}-goal`}
              inputMode="decimal"
              value={goal}
              placeholder="1000000"
              onChange={(e) => setGoal(e.target.value)}
              className="w-36 rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800"
            />
            {goalMinor !== null && (
              <span className="font-semibold">
                {Math.round(chanceOfReaching(range.finals, goalMinor) * 100)}%
              </span>
            )}
          </label>
          {o.standIns.length > 0 && (
            <p className="text-xs text-slate-500">
              Before they existed,{" "}
              {o.standIns
                .map((s) => `${s.symbol.replace("TSP-", "")} uses ${s.by.replace("TSP-", "")}`)
                .join("; ")}{" "}
              (the nearest L fund then).
            </p>
          )}
          {o.unpriced.length > 0 && (
            <p className="text-xs text-slate-500">
              No prices on file for {o.unpriced.join(", ")}, so they are left out of the mix.
            </p>
          )}
          <p className="text-xs text-slate-500">
            Past years in a random order, with today&apos;s mix kept all along (an L fund really
            grows safer as its date nears, so its later years would swing less). History does not
            promise the future.
          </p>
        </>
      )}
    </div>
  );
}
