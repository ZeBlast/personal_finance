import { useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { buttonClass, inputClass } from "../components/investments/styles";
import { useApi } from "../hooks/useApi";
import { useMeasuredWidth } from "../hooks/useMeasuredWidth";
import { formatAxisMoney, formatMinor, parseMoneyToMinor } from "../lib/money";
import { monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import { announceDataChanged } from "../lib/syncEvents";
import type { Settings } from "../types/api";

export interface PayoffPlan {
  months: number | null;
  totalInterestMinor: number;
  monthlyPaymentMinor: number;
  debts: Array<{ id: number; name: string; payoffMonth: number | null; interestMinor: number }>;
  balances: number[];
}

export interface DebtOverview {
  debts: Array<{
    id: number;
    name: string;
    type: string;
    balanceMinor: number;
    aprBps: number | null;
    minimumMinor: number;
    minimumEstimated: boolean;
  }>;
  missingRate: string[];
  strategy: "avalanche" | "snowball";
  extraMinor: number;
  plan: PayoffPlan;
  minimumsOnly: PayoffPlan;
}

const money = (n: number) => formatMinor(n, "USD");

/** "24.99" (percent) as hundredths of a percent, or null. Pure. */
export function parseApr(text: string): number | null {
  const t = text.trim().replace(/%$/, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps <= 10_000 ? bps : null;
}

/** When a plan is done, in words: "March 2028 (17 months)". Pure. */
export function payoffWhen(months: number | null, now: string = today()): string {
  if (months === null) return "never: the payments do not cover the interest";
  if (months === 0) return "already paid";
  return `${monthLabel(shiftMonth(monthOf(now), months), "long")} (${months} month${months === 1 ? "" : "s"})`;
}

/** Cards and loans: what they cost in interest, and how soon paying a little more clears them. */
export function DebtPage() {
  const [extra, setExtra] = useState("100");
  const [strategy, setStrategy] = useState<DebtOverview["strategy"]>("avalanche");
  const extraMinor = parseMoneyToMinor(extra, "USD", { allowZero: true }) ?? 0;
  const { data, error, reload } = useApi<DebtOverview>(
    `/debt?extraMinor=${extraMinor}&strategy=${strategy}`,
  );
  const plan = data?.plan;
  const base = data?.minimumsOnly;
  // The extra the forecast counts (a setting), which can differ from the one being tried here.
  const settings = useApi<Settings>("/settings");
  const counted = settings.data?.debtExtraInForecastMinor ?? 0;
  async function countInForecast(minor: number): Promise<void> {
    await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ debtExtraInForecastMinor: minor }),
    });
    settings.reload();
    announceDataChanged();
  }

  return (
    <section className="@container max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Debt payoff</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Enter each card&apos;s or loan&apos;s interest rate (and its minimum, if you know it) to
          see when it is paid off and what paying a little more each month saves.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {data && data.debts.length === 0 && (
        <p className="text-sm text-slate-500">No card or loan owes anything right now.</p>
      )}
      {data && data.debts.length > 0 && (
        <div className="grid items-start gap-4 @min-[60rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="font-semibold">What you owe</h2>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.debts.map((d) => (
                <DebtRow key={d.id} debt={d} onSaved={reload} />
              ))}
            </ul>
            {data.missingRate.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Left out of the plan until their rate is entered: {data.missingRate.join(", ")}.
              </p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="font-semibold">The plan</h2>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="block">
                <span className="font-medium">Extra each month</span>
                <input
                  inputMode="decimal"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  className={`${inputClass} w-28`}
                />
              </label>
              <fieldset>
                <legend className="font-medium">Put the extra on</legend>
                <label className="mr-3 inline-flex items-center gap-1">
                  <input
                    type="radio"
                    checked={strategy === "avalanche"}
                    onChange={() => setStrategy("avalanche")}
                  />
                  Highest rate first
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="radio"
                    checked={strategy === "snowball"}
                    onChange={() => setStrategy("snowball")}
                  />
                  Smallest balance first
                </label>
              </fieldset>
            </div>
            {plan && base && plan.debts.length > 0 && (
              <>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-slate-500">Paying each month</dt>
                  <dd className="tabular-nums">{money(plan.monthlyPaymentMinor)}</dd>
                  <dt className="text-slate-500">Debt-free</dt>
                  <dd>{payoffWhen(plan.months)}</dd>
                  <dt className="text-slate-500">Interest paid</dt>
                  <dd className="tabular-nums">{money(plan.totalInterestMinor)}</dd>
                </dl>
                {base.months !== plan.months && (
                  <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-200">
                    Against the minimums alone ({payoffWhen(base.months)}
                    {base.months !== null &&
                      `, ${money(base.totalInterestMinor)} of interest`}):{" "}
                    {base.months !== null && plan.months !== null
                      ? `${base.months - plan.months} months sooner and ${money(base.totalInterestMinor - plan.totalInterestMinor)} less interest.`
                      : "this plan pays it off."}
                  </p>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={counted > 0}
                    disabled={extraMinor === 0}
                    onChange={(e) => void countInForecast(e.target.checked ? extraMinor : 0)}
                  />
                  <span>
                    Count {money(counted > 0 ? counted : extraMinor)} a month in the cash forecast
                    <span className="block text-xs text-slate-500">
                      Taken off on the 1st of each month until the plan is done, so the forecast and
                      safe-to-spend do not treat it as free cash.
                      {counted > 0 && counted !== extraMinor && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="text-blue-600 underline"
                            onClick={() => void countInForecast(extraMinor)}
                          >
                            Use {money(extraMinor)} instead
                          </button>
                        </>
                      )}
                    </span>
                  </span>
                </label>
                <BalanceChart
                  plan={plan.balances}
                  minimums={base.balances}
                  planMonths={plan.months}
                  minimumsMonths={base.months}
                />
                <ol className="space-y-1 text-sm">
                  {plan.debts.map((d) => (
                    <li key={d.id} className="flex justify-between gap-2">
                      <span>{d.name}</span>
                      <span className="text-slate-500">
                        {d.payoffMonth === null
                          ? "not paid off"
                          : monthLabel(shiftMonth(monthOf(today()), d.payoffMonth))}{" "}
                        · {money(d.interestMinor)} interest
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            <p className="text-xs text-slate-500">
              An estimate: interest is charged monthly at the rate you enter, and new purchases are
              not counted. Highest rate first pays the least interest; smallest balance first clears
              whole debts sooner.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function DebtRow({ debt, onSaved }: { debt: DebtOverview["debts"][number]; onSaved: () => void }) {
  const [apr, setApr] = useState(debt.aprBps === null ? "" : (debt.aprBps / 100).toFixed(2));
  const [minimum, setMinimum] = useState(
    debt.minimumEstimated ? "" : (debt.minimumMinor / 100).toFixed(2),
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [apr, minimum]);

  async function save(): Promise<void> {
    const aprBps = parseApr(apr);
    if (aprBps === null) return setError("Enter the rate as a percent, such as 24.99.");
    const minimumMinor = minimum.trim() === "" ? null : parseMoneyToMinor(minimum, "USD");
    if (minimum.trim() !== "" && minimumMinor === null) {
      return setError("Enter the minimum as an amount, or leave it empty to estimate it.");
    }
    try {
      await api(`/debt/${debt.id}`, {
        method: "PUT",
        body: JSON.stringify({ aprBps, minimumMinor }),
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex justify-between gap-2">
        <span className="font-medium">{debt.name}</span>
        <span className="tabular-nums">{money(debt.balanceMinor)}</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-xs">
          Rate (APR %)
          <input
            inputMode="decimal"
            value={apr}
            placeholder="24.99"
            onChange={(e) => setApr(e.target.value)}
            className={`${inputClass} w-24`}
          />
        </label>
        <label className="block text-xs">
          Minimum a month
          <input
            inputMode="decimal"
            value={minimum}
            placeholder={`about ${(debt.minimumMinor / 100).toFixed(0)}`}
            onChange={(e) => setMinimum(e.target.value)}
            className={`${inputClass} w-28`}
          />
        </label>
        <button type="button" className={buttonClass} onClick={() => void save()}>
          Save
        </button>
      </div>
      {debt.minimumEstimated && (
        <p className="text-xs text-slate-500">
          Minimum estimated as a month&apos;s interest plus 1% ({money(debt.minimumMinor)}).
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}

/** The month a plan ends, for a chart label: "Oct 2029", or "Not paid off". Pure. */
export function payoffMonthLabel(months: number | null, now: string = today()): string {
  return months === null ? "Not paid off" : monthLabel(shiftMonth(monthOf(now), months));
}

const CHART = { left: 44, right: 12, top: 16, bottom: 22, height: 150, labelWidth: 56 };

/** What is owed month by month: this plan against the minimums only, with axes and end dates. */
function BalanceChart({
  plan,
  minimums,
  planMonths,
  minimumsMonths,
}: {
  plan: number[];
  minimums: number[];
  planMonths: number | null;
  minimumsMonths: number | null;
}) {
  const { ref, width } = useMeasuredWidth();
  const length = Math.min(Math.max(plan.length, minimums.length), 361);
  const top = Math.max(1, ...plan, ...minimums.slice(0, length));
  const plotWidth = Math.max(1, width - CHART.left - CHART.right);
  const baseline = CHART.height - CHART.bottom;
  const x = (i: number) => CHART.left + (i / Math.max(1, length - 1)) * plotWidth;
  const y = (v: number) => CHART.top + (1 - v / top) * (baseline - CHART.top);
  const line = (values: number[]) =>
    values
      .slice(0, length)
      .map((v, i) => `${x(i)},${y(v)}`)
      .join(" ");
  const planEnd = x(Math.min(plan.length, length) - 1);
  const minimumsEnd = x(Math.min(minimums.length, length) - 1);
  // Each label sits just above the baseline at the end of its line; the second goes higher if close.
  const planOnLeft = planEnd > width - CHART.right - CHART.labelWidth;
  const crowded = minimumsEnd - planEnd < CHART.labelWidth * 1.5;
  const now = today();
  const axisText = "fill-slate-500 text-[11px] dark:fill-slate-400";
  const endText =
    "text-[11px] font-medium tabular-nums stroke-white dark:stroke-slate-900 [paint-order:stroke]";
  return (
    <figure>
      <div ref={ref}>
        <svg width={width} height={CHART.height} className="block" role="img">
          <title>What is owed over time: this plan against the minimums only</title>
          {[0, top / 2, top].map((v) => (
            <g key={v}>
              <line
                x1={CHART.left}
                x2={width - CHART.right}
                y1={y(v)}
                y2={y(v)}
                className={
                  v === 0
                    ? "stroke-slate-400 dark:stroke-slate-500"
                    : "stroke-slate-200 dark:stroke-slate-700"
                }
              />
              <text
                x={CHART.left - 6}
                y={y(v) + 4}
                textAnchor="end"
                className={`${axisText} tabular-nums`}
              >
                {formatAxisMoney(v)}
              </text>
            </g>
          ))}
          <text x={CHART.left} y={CHART.height - 6} className={axisText}>
            {payoffMonthLabel(0, now)}
          </text>
          <text x={width - CHART.right} y={CHART.height - 6} textAnchor="end" className={axisText}>
            {payoffMonthLabel(length - 1, now)}
          </text>
          <polyline
            points={line(minimums)}
            fill="none"
            strokeWidth={1.5}
            className="stroke-slate-400"
          />
          <polyline
            points={line(plan)}
            fill="none"
            strokeWidth={2}
            className="stroke-blue-600 dark:stroke-blue-400"
          />
          <text
            x={planOnLeft ? planEnd : planEnd + 4}
            y={baseline - 6}
            textAnchor={planOnLeft ? "end" : "start"}
            strokeWidth={3}
            className={`${endText} fill-blue-700 dark:fill-blue-300`}
          >
            {payoffMonthLabel(planMonths, now)}
          </text>
          <text
            x={minimumsEnd}
            y={baseline - 6 - (crowded ? 14 : 0)}
            textAnchor="end"
            strokeWidth={3}
            className={`${endText} fill-slate-600 dark:fill-slate-300`}
          >
            {payoffMonthLabel(minimumsMonths, now)}
          </text>
        </svg>
      </div>
      <figcaption className="text-xs text-slate-500">
        <span className="text-blue-600">This plan</span> against{" "}
        <span className="text-slate-400">the minimums only</span>.
      </figcaption>
    </figure>
  );
}
