import { useMemo, useState } from "react";
import { LineChart } from "../components/charts/LineChart";
import { Loading } from "../components/common/Loading";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { defaultSaving, projectOutlook } from "../lib/outlook";
import { today } from "../lib/period";
import { formatDay } from "../lib/time";
import type { OutlookInputs } from "../types/planTools";

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900";

/** A number typed in a box, or the fallback while it is not a number. */
const numberOr = (text: string, fallback: number): number => {
  const n = Number(text.replace(/[,\s$%]/g, ""));
  return text.trim() !== "" && Number.isFinite(n) ? n : fallback;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Planning > Long-range: net worth over the years, from today's figures and a few assumptions. */
export function OutlookPage() {
  const { data, error, loading } = useApi<OutlookInputs>(`/outlook?today=${today()}`);
  const [saving, setSaving] = useState<string | null>(null);
  const [years, setYears] = useState("30");
  const [low, setLow] = useState("3");
  const [mid, setMid] = useState("5");
  const [high, setHigh] = useState("7");
  const [multiple, setMultiple] = useState("25");
  const currency = data?.currency ?? "USD";
  const money = (n: number) => formatMinor(n, currency);

  const outlook = useMemo(() => {
    if (!data) return null;
    const perMonth = saving === null ? defaultSaving(data) : Math.round(numberOr(saving, 0) * 100);
    return projectOutlook(data, {
      years: Math.min(60, Math.max(1, Math.round(numberOr(years, 30)))),
      savingPerMonthMinor: Math.max(0, perMonth),
      rates: [numberOr(low, 3) / 100, numberOr(mid, 5) / 100, numberOr(high, 7) / 100],
      multiple: Math.max(1, numberOr(multiple, 25)),
    });
  }, [data, saving, years, low, mid, high, multiple]);

  const last = outlook?.points.at(-1);
  const startYear = Number((data?.today ?? "2000").slice(0, 4));
  const milestones: Array<{ when: string; what: string }> = [];
  if (data && outlook) {
    if (data.debtMinor > 0) {
      milestones.push(
        data.debtOutsidePlanMinor > 0
          ? {
              when: "Not known",
              what: `Debt-free: ${money(data.debtOutsidePlanMinor)} of debt has no interest rate yet, so the payoff plan leaves it out`,
            }
          : outlook.debtFreeYear === null
            ? { when: "Not yet", what: "Debt-free: the payments never catch up with the interest" }
            : {
                when: String(startYear + outlook.debtFreeYear),
                what: "Debt-free, on the payoff plan",
              },
      );
    }
    for (const g of data.goals) {
      if (g.targetDate)
        milestones.push({ when: formatDay(g.targetDate), what: `${g.name} reached` });
    }
    milestones.push(
      outlook.workOptionalYear === null
        ? {
            when: "Beyond this view",
            what: `Work optional: savings of ${numberOr(multiple, 25)} times a year's spending`,
          }
        : {
            when: String(startYear + outlook.workOptionalYear),
            what: `Work optional: savings of ${numberOr(multiple, 25)} times a year's spending`,
          },
    );
  }

  return (
    <section className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Long-range outlook</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {last
            ? `About ${money(last.mid)} of net worth by ${last.year}, between ${money(last.low)} and ${money(last.high)}.`
            : "Where your net worth could be in the years ahead."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {loading && !data && <Loading lines={6} />}
      {data && outlook && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <label className="col-span-2 text-xs text-slate-500 dark:text-slate-400">
              Left over each month
              <input
                className={inputClass}
                inputMode="decimal"
                value={saving ?? String(defaultSaving(data) / 100)}
                onChange={(e) => setSaving(e.target.value)}
              />
              <span className="mt-1 block">
                {data.monthsAveraged === 0
                  ? "No complete month to go by yet."
                  : `Your last ${plural(data.monthsAveraged, "month", "months")}: ${money(data.monthlyIncomeMinor)} in, ${money(data.monthlySpendingMinor)} spent.`}
              </span>
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Years
              <input
                className={inputClass}
                inputMode="numeric"
                value={years}
                onChange={(e) => setYears(e.target.value)}
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Growth: low, mid, high (%)
              <span className="flex gap-1">
                <input
                  aria-label="Low growth"
                  className={inputClass}
                  value={low}
                  onChange={(e) => setLow(e.target.value)}
                />
                <input
                  aria-label="Middle growth"
                  className={inputClass}
                  value={mid}
                  onChange={(e) => setMid(e.target.value)}
                />
                <input
                  aria-label="High growth"
                  className={inputClass}
                  value={high}
                  onChange={(e) => setHigh(e.target.value)}
                />
              </span>
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Work optional at (× a year&apos;s spending)
              <input
                className={inputClass}
                inputMode="numeric"
                value={multiple}
                onChange={(e) => setMultiple(e.target.value)}
              />
            </label>
          </div>

          <LineChart
            drawToWidth
            maxHeight={320}
            format={money}
            series={[
              {
                key: "high",
                label: "High growth",
                color: "#16a34a",
                points: outlook.points.map((p) => ({ date: `${p.year}-01-01`, value: p.high })),
              },
              {
                key: "mid",
                label: "Middle",
                color: "#2563eb",
                points: outlook.points.map((p) => ({ date: `${p.year}-01-01`, value: p.mid })),
              },
              {
                key: "low",
                label: "Low growth",
                color: "#94a3b8",
                points: outlook.points.map((p) => ({ date: `${p.year}-01-01`, value: p.low })),
              },
            ]}
          />

          <div>
            <h2 className="text-lg font-semibold">Milestones</h2>
            <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
              {milestones.map((m) => (
                <li key={m.what} className="flex gap-4 py-2 text-sm">
                  <span className="w-32 shrink-0 text-slate-500 dark:text-slate-400">{m.when}</span>
                  <span>{m.what}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            An estimate in today&apos;s money: investments grow at a steady rate and what is left
            over each month goes into them, less card payments while the payoff plan runs; cash and
            other assets stay as they are; debts follow your debt payoff plan. Starting from{" "}
            {money(data.netWorthMinor)} of net worth today.
          </p>
        </>
      )}
    </section>
  );
}
