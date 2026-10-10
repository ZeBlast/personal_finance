import { useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { buttonClass } from "../components/investments/styles";
import { UtilizationChart } from "../components/insights/UtilizationChart";
import { useApi } from "../hooks/useApi";
import { CADENCE_LABEL, dueLabel } from "../lib/insights";
import { formatMinor } from "../lib/money";
import { today } from "../lib/period";
import { announceDataChanged } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import type { RecurringReport, RecurringSeries, UtilizationHistory } from "../types/insights";

/** `YYYY-MM-DD` this many days before `day`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function SeriesRow({
  series,
  asOf,
  currency,
  busy,
  onToggle,
}: {
  series: RecurringSeries;
  asOf: string;
  currency: string;
  busy: boolean;
  onToggle: () => void;
}) {
  const money = (n: number) => formatMinor(n, currency);
  const lapsed = series.status === "lapsed";
  return (
    <tr className="border-t border-slate-100 align-top dark:border-slate-700">
      <td className="py-2 pr-3">
        <div className={`font-medium ${series.dismissed ? "text-slate-400 line-through" : ""}`}>
          {series.merchant}
        </div>
        <div className="text-xs text-slate-500">
          {CADENCE_LABEL[series.cadence]} · seen {series.occurrences} times ·{" "}
          {series.accountNames.join(", ")}
        </div>
        {series.priceChange && (
          <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            Changed from {money(series.priceChange.fromMinor)} to{" "}
            {money(series.priceChange.toMinor)} on {formatDay(series.priceChange.date)}
          </div>
        )}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">
        {series.amountVaries ? "about " : ""}
        <span className={series.direction === "in" ? "text-green-700 dark:text-green-400" : ""}>
          {series.direction === "in" ? "+" : ""}
          {money(series.typicalAmountMinor)}
        </span>
        {series.amountVaries && <div className="text-xs text-slate-500">varies</div>}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{money(series.perMonthMinor)}</td>
      <td className="py-2 pr-3">
        {lapsed ? (
          <span className="text-amber-700 dark:text-amber-400">
            Seems to have stopped
            <span className="block text-xs text-slate-500">
              last on {formatDay(series.lastDate)}
            </span>
          </span>
        ) : (
          <>
            {formatDay(series.nextExpected)}
            <span className="block text-xs text-slate-500">
              {dueLabel(series.nextExpected, asOf)}
            </span>
          </>
        )}
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          aria-label={`${series.dismissed ? "Show again" : "Not recurring"}: ${series.merchant}`}
          onClick={onToggle}
        >
          {series.dismissed ? "Show again" : "Not recurring"}
        </button>
      </td>
    </tr>
  );
}

function RecurringSection() {
  const [showHidden, setShowHidden] = useState(false);
  const { data, error, loading, reload } = useApi<RecurringReport>(
    `/insights/recurring${showHidden ? "?includeDismissed=1" : ""}`,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");

  async function toggle(series: RecurringSeries): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/insights/recurring/${series.dismissed ? "restore" : "dismiss"}`, {
        method: "POST",
        body: JSON.stringify({ key: series.key, merchant: series.merchant }),
      });
      reload();
      announceDataChanged();
    } catch (e) {
      setProblem(errorMessage(e, "Could not change that."));
    } finally {
      setBusy(false);
    }
  }

  const groups: Array<{ title: string; rows: RecurringSeries[] }> = data
    ? [
        { title: "Charges", rows: data.series.filter((s) => s.direction === "out") },
        { title: "Regular deposits", rows: data.series.filter((s) => s.direction === "in") },
      ]
    : [];

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Recurring charges and deposits</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Found by looking for payments that repeat at steady intervals (at least three, two for
            yearly). Transfers between your own accounts and card payments are left out. If
            something is not really a subscription, mark it and it disappears.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show ones I marked not recurring
        </label>
      </div>
      {(error || problem) && (
        <p role="alert" className="text-sm text-red-600">
          {error ?? problem}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && (
        <>
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <div className="text-xs text-slate-500">Recurring charges</div>
              <div className="text-xl font-semibold tabular-nums">
                {money(data.monthlyOutMinor)} / month
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Regular deposits</div>
              <div className="text-xl font-semibold tabular-nums">
                {money(data.monthlyInMinor)} / month
              </div>
            </div>
          </div>
          {data.series.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nothing repeating found yet. The app looked at {data.basis.transactions} transactions
              from the last {data.basis.days} days; patterns appear after a few months of history.
            </p>
          ) : (
            groups
              .filter((g) => g.rows.length > 0)
              .map((g) => (
                <div key={g.title} className="overflow-x-auto">
                  <h3 className="mb-1 text-sm font-medium">{g.title}</h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500">
                        <th scope="col" className="pb-1 font-medium">
                          Who
                        </th>
                        <th scope="col" className="pb-1 pr-3 text-right font-medium">
                          Usual amount
                        </th>
                        <th scope="col" className="pb-1 pr-3 text-right font-medium">
                          Per month
                        </th>
                        <th scope="col" className="pb-1 font-medium">
                          Next expected
                        </th>
                        <th scope="col" className="pb-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((s) => (
                        <SeriesRow
                          key={s.key}
                          series={s}
                          asOf={data.asOf}
                          currency={data.currency}
                          busy={busy}
                          onToggle={() => void toggle(s)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
          )}
          <p className="text-xs text-slate-500">
            Monthly figures turn each payment into a per-month estimate (a weekly charge counts as
            4.3 a month) and include only items that are still active.
          </p>
        </>
      )}
    </section>
  );
}

const RANGES = [
  { value: "90", label: "3 months" },
  { value: "365", label: "12 months" },
  { value: "36500", label: "Everything" },
];

function UtilizationSection() {
  const [range, setRange] = useState("365");
  const [perCard, setPerCard] = useState(false);
  const from = useMemo(() => daysBefore(today(), Number(range)), [range]);
  const { data, error, loading } = useApi<UtilizationHistory>(
    `/insights/credit-utilization?from=${from}`,
  );
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Credit utilization</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            The share of each card's limit in use. Lower is generally better for credit, and under
            30% is the figure usually suggested. A point appears only on days both a balance and a
            limit were recorded.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={perCard}
              onChange={(e) => setPerCard(e.target.checked)}
            />
            Each card separately
          </label>
          <select
            aria-label="How far back"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-600 dark:bg-slate-800"
          >
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && data.cards.length === 0 && (
        <p className="text-sm text-slate-500">No credit cards connected.</p>
      )}
      {data && data.cards.length > 0 && (
        <>
          <UtilizationChart history={data} perCard={perCard} />
          <div>
            <h3 className="mb-1 text-sm font-medium">Limit changes</h3>
            {data.limitChanges.length === 0 ? (
              <p className="text-sm text-slate-500">No limit changes in this period.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.limitChanges.map((c) => (
                  <li
                    key={`${c.accountId}-${c.date}-${c.toMinor}`}
                    className="flex flex-wrap gap-x-2"
                  >
                    <span className="font-medium">{c.name}</span>
                    <span>
                      {money(c.fromMinor)} → {money(c.toMinor)}{" "}
                      <span
                        className={
                          c.toMinor > c.fromMinor
                            ? "text-green-700 dark:text-green-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        ({c.toMinor > c.fromMinor ? "+" : "−"}
                        {money(Math.abs(c.toMinor - c.fromMinor))})
                      </span>
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatDay(c.date)} ·{" "}
                      {c.source === "manual" ? "entered by hand" : "seen from the bank"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function InsightsPage() {
  return (
    <section className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Insights</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Patterns the app can see in your own data. Nothing here is advice, and nothing is
          estimated beyond what is stated.
        </p>
      </div>
      <RecurringSection />
      <UtilizationSection />
    </section>
  );
}
