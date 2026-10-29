import { useMemo, useState } from "react";
import { useDateBasis } from "../../hooks/useDateBasis";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { lastOfMonth, monthLabel, monthOf, shiftMonth, today } from "../../lib/period";
import { formatDay } from "../../lib/time";
import type { TransactionPage } from "../../types/api";
import type { CalendarDay, CalendarMonth } from "../../types/analytics";
import { Loading } from "../common/Loading";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_DOTS = 4;

/** The day cells of a month, as a list of weeks. Leading and trailing blanks are `null`. */
export function monthGrid(month: string): Array<Array<string | null>> {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const lastDay = Number(lastOfMonth(month).slice(8));
  const leading = new Date(year, mon - 1, 1).getDay(); // 0 = Sunday
  const cells: Array<string | null> = [
    ...Array<null>(leading).fill(null),
    ...Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function dayLabel(date: string, day: CalendarDay | undefined): string {
  if (!day) return `${formatDay(date)}, no transactions`;
  return `${formatDay(date)}, ${day.count} transaction${day.count === 1 ? "" : "s"}, ${formatMinor(day.outflowMinor, "USD")} out, ${formatMinor(day.inflowMinor, "USD")} in`;
}

/** What happened on one day, listed under the calendar. */
function DayDetail({ date, accountId }: { date: string; accountId: string }) {
  const basis = useDateBasis();
  const query = new URLSearchParams({
    from: date,
    to: date,
    pageSize: "100",
    sort: "amount_asc",
    dateBasis: basis,
  });
  if (accountId) query.set("accountId", accountId);
  const { data, error, loading } = useApi<TransactionPage>(`/transactions?${query}`);

  return (
    <section
      aria-label={`Transactions on ${formatDay(date)}`}
      className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700"
    >
      <h3 className="text-sm font-medium">{formatDay(date)}</h3>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <Loading />}
      {data && data.items.length === 0 && (
        <p className="text-sm text-slate-500">No transactions on this day.</p>
      )}
      <ul className="mt-1 space-y-1">
        {data?.items.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
              />
              <span className="truncate">{t.merchant}</span>
              {t.pending && (
                <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-900">
                  Pending
                </span>
              )}
              <span className="shrink-0 text-xs text-slate-500">{t.accountName}</span>
              {t.recipient && (
                <span className="shrink-0 text-xs text-slate-500">→ {t.recipient}</span>
              )}
            </span>
            <span
              className={`shrink-0 tabular-nums ${t.amountMinor < 0 ? "font-medium text-green-700 dark:text-green-400" : ""}`}
            >
              {t.amountMinor < 0 ? "+" : ""}
              {formatMinor(-t.amountMinor, t.currency)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A month calendar showing, for each day, how many transactions there were, how much went out and
 * came in, and which accounts they were on (a colored dot per account). Choosing a day lists its
 * transactions underneath. `accountId` limits it to one account ("" for all).
 */
export function CalendarView({ accountId, compact }: { accountId: string; compact?: boolean }) {
  const [month, setMonth] = useState(() => monthOf(today()));
  const [selected, setSelected] = useState<string | null>(null);
  const basis = useDateBasis();
  const query = accountId ? `&accountId=${accountId}` : "";
  const { data, error, loading } = useApi<CalendarMonth>(
    `/analytics/calendar?month=${month}${query}&dateBasis=${basis}`,
  );

  const byDate = useMemo(() => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);
  const weeks = useMemo(() => monthGrid(month), [month]);
  const todayDay = today();

  const go = (delta: number): void => {
    setMonth((m) => shiftMonth(m, delta));
    setSelected(null);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => go(-1)}
          className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-600"
        >
          ‹
        </button>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold" aria-live="polite">
            {monthLabel(month, "long")}
          </h3>
          {month !== monthOf(todayDay) && (
            <button
              type="button"
              onClick={() => {
                setMonth(monthOf(todayDay));
                setSelected(null);
              }}
              className="text-xs text-blue-600 underline"
            >
              Today
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => go(1)}
          className="rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-600"
        >
          ›
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <Loading />}

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500" aria-hidden="true">
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {weeks.flat().map((date, index) => {
          if (date === null) return <div key={`blank-${index}`} />;
          const day = byDate.get(date);
          const isSelected = selected === date;
          return (
            <button
              key={date}
              type="button"
              aria-label={dayLabel(date, day)}
              aria-pressed={isSelected}
              onClick={() => setSelected(isSelected ? null : date)}
              className={`flex flex-col items-stretch rounded border px-1 py-1 text-left text-xs ${compact ? "min-h-12" : "min-h-16"} ${
                isSelected
                  ? "border-blue-600 bg-blue-50 dark:bg-blue-950"
                  : date === todayDay
                    ? "border-blue-400"
                    : "border-slate-200 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              }`}
            >
              <span
                className={
                  date === todayDay
                    ? "font-bold text-blue-700 dark:text-blue-400"
                    : "text-slate-600 dark:text-slate-300"
                }
              >
                {Number(date.slice(8))}
              </span>
              {day && (
                <>
                  {!compact && day.outflowMinor > 0 && (
                    <span className="truncate tabular-nums">
                      −{formatMinor(day.outflowMinor, "USD")}
                    </span>
                  )}
                  {!compact && day.inflowMinor > 0 && (
                    <span className="truncate tabular-nums text-green-700 dark:text-green-400">
                      +{formatMinor(day.inflowMinor, "USD")}
                    </span>
                  )}
                  <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-0.5">
                    {day.accounts.slice(0, MAX_DOTS).map((a) => (
                      <span
                        key={a.accountId}
                        aria-hidden="true"
                        title={`${a.name}: ${a.count}`}
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: a.color ?? "#94a3b8" }}
                      />
                    ))}
                    {compact && <span className="text-[10px] text-slate-500">{day.count}</span>}
                    {day.pendingCount > 0 && (
                      <span aria-hidden="true" className="text-[10px] text-amber-600">
                        ●
                      </span>
                    )}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {data && data.days.length === 0 && !loading && (
        <p className="mt-2 text-sm text-slate-500">
          No transactions in {monthLabel(month, "long")}.
        </p>
      )}
      {selected && <DayDetail date={selected} accountId={accountId} />}
    </div>
  );
}
