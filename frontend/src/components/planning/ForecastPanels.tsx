import { X } from "lucide-react";
import {
  biggestOut,
  bySource,
  filterEvents,
  NO_FILTER,
  weeklyBreakdown,
  type EventFilter,
  type ForecastWeek,
  type Source,
} from "../../lib/forecastSummary";
import { holdBackLine, holdBackSummary } from "../../lib/views";
import { formatDay } from "../../lib/time";
import type { Forecast } from "../../types/planning";
import { Select } from "../common/Select";

export const SOURCE_LABEL: Record<Source, string> = {
  expected: "Expected",
  recurring: "Recurring",
  card_bill: "Card bill",
  pending: "Pending",
  debt_plan: "Debt plan",
  interest: "Interest (from the APY)",
  goal: "Set aside for a goal",
  cap_holdback: "Spending caps (held back)",
  instalment: "Instalment payment",
  scenario: "What-if",
};

type Money = (n: number) => string;

/** "Nov 11 – 15" within a month, "Nov 30 – Dec 6" across two. */
export function weekLabel(w: { start: string; end: string }): string {
  const short = (day: string, withMonth: boolean) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y!, m! - 1, d).toLocaleDateString(
      undefined,
      withMonth ? { month: "short", day: "numeric" } : { day: "numeric" },
    );
  };
  if (w.start === w.end) return short(w.start, true);
  const sameMonth = w.start.slice(0, 7) === w.end.slice(0, 7);
  return `${short(w.start, true)} – ${short(w.end, !sameMonth)}`;
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <h2 className="text-sm font-semibold">{title}</h2>
      {note && <p className="text-xs text-slate-500 dark:text-slate-400">{note}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * The forecast a week at a time: what comes in, what goes out, and where the balance ends (in red,
 * with its low, for a week that dips below zero). A week is a button that narrows the list of what
 * is coming to its days; pressing it again shows everything.
 */
export function WeekByWeek({
  forecast,
  money,
  picked,
  onPick,
}: {
  forecast: Forecast;
  money: Money;
  picked: { start: string; end: string } | null;
  onPick: (week: ForecastWeek | null) => void;
}) {
  const weeks = weeklyBreakdown(forecast.days);
  const most = Math.max(1, ...weeks.map((w) => Math.max(w.inMinor, w.outMinor)));
  return (
    <Panel title="Week by week" note="Pick a week to list only its days below.">
      <ul className="space-y-1">
        {weeks.map((w) => {
          const on = picked?.start === w.start && picked.end === w.end;
          return (
            <li key={w.start}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onPick(on ? null : w)}
                className={`grid w-full grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded px-1.5 py-1 text-left text-xs ${
                  on
                    ? "bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/50"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800"
                }`}
              >
                <span className="font-medium whitespace-nowrap">{weekLabel(w)}</span>
                <span className="space-y-0.5" aria-hidden="true">
                  <span
                    className="block h-1.5 rounded-full bg-green-600 dark:bg-green-400"
                    style={{ width: `${(w.inMinor / most) * 100}%` }}
                  />
                  <span
                    className="block h-1.5 rounded-full bg-red-500 dark:bg-red-400"
                    style={{ width: `${(w.outMinor / most) * 100}%` }}
                  />
                </span>
                <span className="text-right tabular-nums">
                  <span
                    className={`block font-medium ${w.lowestMinor < 0 ? "text-red-600 dark:text-red-400" : ""}`}
                  >
                    {money(w.endBalanceMinor)}
                  </span>
                  <span className="block text-slate-500 dark:text-slate-400">
                    {w.inMinor > 0 ? `+${money(w.inMinor)} ` : ""}
                    {w.outMinor > 0 ? `−${money(w.outMinor)}` : ""}
                    {w.inMinor === 0 && w.outMinor === 0 ? "Nothing moves" : ""}
                    {w.lowestMinor < 0 ? ` · low ${money(w.lowestMinor)}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 flex gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className="h-1.5 w-3 rounded-full bg-green-600 dark:bg-green-400"
          />
          In
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="h-1.5 w-3 rounded-full bg-red-500 dark:bg-red-400" />
          Out
        </span>
        <span>The amount is the balance at the week&apos;s end.</span>
      </p>
    </Panel>
  );
}

/** Money in and out by kind over the whole forecast; a kind is a button that lists only it below. */
export function ByKind({
  forecast,
  money,
  picked,
  onPick,
}: {
  forecast: Forecast;
  money: Money;
  picked: Source | "all";
  onPick: (source: Source | "all") => void;
}) {
  const kinds = bySource(forecast.days);
  const most = Math.max(1, ...kinds.map((k) => Math.max(k.inMinor, k.outMinor)));
  if (kinds.length === 0) return null;
  return (
    <Panel title="By kind">
      <ul className="space-y-1">
        {kinds.map((k) => {
          // The hold-back is not in the list below, so there is nothing to narrow it to.
          const listed = k.source !== "cap_holdback";
          const on = picked === k.source;
          const body = (
            <>
              <span className="flex justify-between gap-2">
                <span className="truncate">
                  {SOURCE_LABEL[k.source]}
                  {listed ? ` · ${k.count}` : ""}
                </span>
                <span className="tabular-nums whitespace-nowrap">
                  {k.inMinor > 0 && (
                    <span className="text-green-700 dark:text-green-400">+{money(k.inMinor)}</span>
                  )}
                  {k.inMinor > 0 && k.outMinor > 0 ? " " : ""}
                  {k.outMinor > 0 && <span>−{money(k.outMinor)}</span>}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="mt-0.5 block h-1.5 rounded-full bg-slate-100 dark:bg-slate-700"
              >
                <span
                  className={`block h-full rounded-full ${k.outMinor >= k.inMinor ? "bg-red-500 dark:bg-red-400" : "bg-green-600 dark:bg-green-400"}`}
                  style={{ width: `${(Math.max(k.inMinor, k.outMinor) / most) * 100}%` }}
                />
              </span>
            </>
          );
          return (
            <li key={k.source} className="text-xs">
              {listed ? (
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onPick(on ? "all" : k.source)}
                  className={`block w-full rounded px-1.5 py-1 text-left ${
                    on
                      ? "bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/50"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  {body}
                </button>
              ) : (
                <div className="px-1.5 py-1">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** The largest payments going out in the forecast. */
export function BiggestAhead({ forecast, money }: { forecast: Forecast; money: Money }) {
  const biggest = biggestOut(forecast.days, 5);
  if (biggest.length === 0) return null;
  return (
    <Panel title="Biggest payments ahead">
      <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
        {biggest.map((e, i) => (
          <li key={`${e.date}-${i}`} className="flex items-baseline justify-between gap-2 py-1">
            <span className="min-w-0">
              <span className="block truncate">{e.label}</span>
              <span className="block text-slate-500 dark:text-slate-400">
                {formatDay(e.date)} · {SOURCE_LABEL[e.source]}
              </span>
            </span>
            <span className="tabular-nums">{money(e.amountMinor)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Everything the forecast expects, day by day, with the balance after each day. It can be narrowed
 * to money in or out, one kind, some words, or one week (picked from Week by week).
 */
export function UpcomingTable({
  forecast,
  money,
  filter,
  onFilter,
}: {
  forecast: Forecast;
  money: Money;
  filter: EventFilter;
  onFilter: (f: EventFilter) => void;
}) {
  const upcoming = filterEvents(forecast.days, filter);
  const held = holdBackSummary(forecast.days);
  const everything = filterEvents(forecast.days, NO_FILTER);
  const kinds = [...new Set(everything.flatMap((d) => d.events.map((e) => e.source)))];
  const narrowed =
    filter.direction !== "all" ||
    filter.source !== "all" ||
    filter.text.trim() !== "" ||
    (filter.range ?? null) !== null;
  const shown = upcoming.reduce((n, d) => n + d.events.length, 0);
  const total = upcoming.reduce((n, d) => n + d.events.reduce((m, e) => m + e.amountMinor, 0), 0);
  const control =
    "rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900";

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-sm font-semibold">
          What is coming
          <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
            {shown} {shown === 1 ? "item" : "items"}
            {narrowed && shown > 0 ? `, ${total > 0 ? "+" : ""}${money(total)} in all` : ""}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {filter.range && (
            <button
              type="button"
              onClick={() => onFilter({ ...filter, range: null })}
              className="flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900 dark:bg-blue-950 dark:text-blue-200"
            >
              {weekLabel(filter.range)}
              <X aria-hidden="true" className="h-3 w-3" />
              <span className="sr-only">Show every week</span>
            </button>
          )}
          <label>
            <span className="sr-only">Money in or out</span>
            <Select
              value={filter.direction}
              onChange={(e) =>
                onFilter({ ...filter, direction: e.target.value as EventFilter["direction"] })
              }
              className={control}
            >
              <option value="all">In and out</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </Select>
          </label>
          <label>
            <span className="sr-only">Kind</span>
            <Select
              value={filter.source}
              onChange={(e) => onFilter({ ...filter, source: e.target.value as Source | "all" })}
              className={control}
            >
              <option value="all">Every kind</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {SOURCE_LABEL[k]}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span className="sr-only">Find in what is coming</span>
            <input
              type="search"
              value={filter.text}
              onChange={(e) => onFilter({ ...filter, text: e.target.value })}
              placeholder="Find..."
              className={`${control} w-36`}
            />
          </label>
          {narrowed && (
            <button
              type="button"
              onClick={() => onFilter(NO_FILTER)}
              className="text-xs text-blue-700 underline dark:text-blue-300"
            >
              Show everything
            </button>
          )}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="py-1 font-medium">Date</th>
            <th className="py-1 font-medium">What</th>
            <th className="py-1 text-right font-medium">Amount</th>
            <th className="py-1 text-right font-medium">Balance after</th>
          </tr>
        </thead>
        <tbody>
          {upcoming.flatMap((d) =>
            d.events.map((e, i) => (
              <tr
                key={`${d.date}-${i}`}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <td className="py-1 whitespace-nowrap">{i === 0 ? formatDay(d.date) : ""}</td>
                <td className="py-1">
                  {e.label}{" "}
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {SOURCE_LABEL[e.source]}
                    {e.card !== undefined && e.chargedOn !== undefined
                      ? ` · charged to ${e.card} ${formatDay(e.chargedOn)}, paid with its bill`
                      : ""}
                  </span>
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${e.amountMinor > 0 ? "text-green-700 dark:text-green-400" : ""}`}
                >
                  {e.amountMinor > 0 ? "+" : ""}
                  {money(e.amountMinor)}
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${d.balanceMinor < 0 ? "text-red-600" : "text-slate-500"}`}
                >
                  {i === d.events.length - 1 ? money(d.balanceMinor) : ""}
                </td>
              </tr>
            )),
          )}
          {held && !narrowed && (
            <tr className="border-t border-slate-100 dark:border-slate-800">
              <td colSpan={2} className="py-1 text-slate-600 dark:text-slate-300">
                {holdBackLine(held, money)}
              </td>
              <td className="py-1 text-right tabular-nums">{money(-held.totalMinor)}</td>
              <td />
            </tr>
          )}
          {upcoming.length === 0 && (narrowed || !held) && (
            <tr>
              <td colSpan={4} className="py-3 text-slate-500">
                {narrowed
                  ? "Nothing matches. Show everything to see the rest."
                  : "Nothing expected yet. Add expected transactions on the calendar, or set your card bill dates."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
