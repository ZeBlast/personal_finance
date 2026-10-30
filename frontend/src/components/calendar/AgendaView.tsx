import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useDateBasis } from "../../hooks/useDateBasis";
import { formatMinor } from "../../lib/money";
import { firstOfMonth, lastOfMonth, monthOf, shiftMonth, today } from "../../lib/period";
import type { Transaction } from "../../types/api";
import type { CalendarEvent } from "../../types/calendar";
import { LoadMore, PAGE_SIZE } from "./LoadMore";
import { MONTH_NAMES, splitMonth, type DaySpan } from "./range";
import { usePagedTransactions } from "./usePagedTransactions";
import {
  isFiltered,
  matchesSearch,
  showsSource,
  showsTransaction,
  type CalendarFilters,
} from "./filters";
import { MonthOverview } from "./MonthOverview";

const navButton =
  "rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800";

const longDay = (day: string): string =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

interface AgendaDay {
  date: string;
  expected: CalendarEvent[];
  transactions: Transaction[];
}

/**
 * The month as a list, day by day: what is still expected (and what was done or skipped), then
 * what happened. The same transactions and expected items as the month grid, with the same
 * account and date basis. Click a day to look at it in the panel.
 */
export function AgendaView({
  accountId,
  accountName,
  filters,
  onResetFilters,
  selection,
  onSelect,
}: {
  accountId: string;
  accountName: string | null;
  filters: CalendarFilters;
  onResetFilters: () => void;
  selection: DaySpan | null;
  onSelect: (span: DaySpan | null) => void;
}) {
  const todayDay = today();
  const [month, setMonth] = useState(() => monthOf(selection?.from ?? todayDay));
  const basis = useDateBasis();
  const from = firstOfMonth(month);
  const to = lastOfMonth(month);

  const txQuery = new URLSearchParams({
    from,
    to,
    pageSize: String(PAGE_SIZE),
    sort: basis === "posted" ? "date_asc" : "txdate_asc",
    dateBasis: basis,
  });
  const expectedQuery = new URLSearchParams({ from, to, includeResolved: "1" });
  if (accountId) {
    txQuery.set("accountId", accountId);
    expectedQuery.set("accountId", accountId);
  }
  const list = usePagedTransactions(txQuery);
  const expected = useApi<CalendarEvent[]>(`/calendar/expected?${expectedQuery}`);

  const days = useMemo(() => {
    const byDate = new Map<string, AgendaDay>();
    const dayOf = (date: string) => {
      let d = byDate.get(date);
      if (!d) {
        d = { date, expected: [], transactions: [] };
        byDate.set(date, d);
      }
      return d;
    };
    for (const e of expected.data ?? []) {
      if (!showsSource(filters, e.source)) continue;
      if (!matchesSearch(filters, e.merchant, e.categoryName, e.accountName)) continue;
      dayOf(e.date).expected.push(e);
    }
    for (const t of list.items ?? []) {
      if (!showsTransaction(filters, t.pending)) continue;
      if (!matchesSearch(filters, t.merchant, t.category?.name, t.accountName)) continue;
      dayOf(basis === "posted" ? t.date : (t.authorizedDate ?? t.date)).transactions.push(t);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [expected.data, list.items, basis, filters]);

  // Opening on this month, the list starts at today rather than the 1st.
  const list_ = useRef<HTMLDivElement>(null);
  const scrolled = useRef<string | null>(null);
  const loading = list.loading || expected.loading;
  useEffect(() => {
    // Only once both lists are in, or the day would move as the rest arrives.
    if (loading || !list.items || !expected.data) return;
    if (scrolled.current === month || days.length === 0) return;
    scrolled.current = month;
    const target =
      days.find((d) => d.date >= (selection?.from ?? todayDay))?.date ??
      days[days.length - 1]!.date;
    const box = list_.current;
    const row = box?.querySelector<HTMLElement>(`[data-agenda-day="${target}"]`);
    // Scrolls the list alone, not the page around it.
    if (box && row) box.scrollTop = row.offsetTop;
  }, [days, month, selection, todayDay, loading, list.items, expected.data]);

  const { year, monthIndex } = splitMonth(month);
  const error = list.error ?? expected.error;

  return (
    <div className="flex h-full min-h-0 flex-col" data-keep-selection>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            className={navButton}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ‹
          </button>
          <h2 className="min-w-36 text-center text-lg font-semibold">
            {MONTH_NAMES[monthIndex]} {year}
          </h2>
          <button
            type="button"
            aria-label="Next month"
            className={navButton}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-slate-500">Loading...</span>}
          <button
            type="button"
            className={navButton}
            onClick={() => {
              scrolled.current = null;
              setMonth(monthOf(todayDay));
              onSelect({ from: todayDay, to: todayDay });
            }}
          >
            Today
          </button>
        </div>
      </div>
      <MonthOverview month={month} accountId={accountId} accountName={accountName} />
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div
        ref={list_}
        className="relative min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700"
      >
        {!loading && days.length === 0 && (
          <p className="p-4 text-sm text-slate-500">
            {isFiltered(filters) ? (
              <>
                Nothing in {MONTH_NAMES[monthIndex]} matches the filters.{" "}
                <button type="button" className="text-blue-600 underline" onClick={onResetFilters}>
                  Show everything
                </button>
              </>
            ) : (
              <>Nothing happened or is expected in {MONTH_NAMES[monthIndex]}.</>
            )}
          </p>
        )}
        <ol>
          {days.map((d) => (
            <AgendaDayRows
              key={d.date}
              day={d}
              today={todayDay}
              chosen={selection !== null && d.date >= selection.from && d.date <= selection.to}
              onChoose={() => onSelect({ from: d.date, to: d.date })}
            />
          ))}
        </ol>
        {list.items && (
          <div className="px-3 pb-3">
            <LoadMore
              shown={list.items.length}
              total={list.total}
              busy={list.loadingMore}
              onMore={() => void list.loadMore()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AgendaDayRows({
  day,
  today,
  chosen,
  onChoose,
}: {
  day: AgendaDay;
  today: string;
  chosen: boolean;
  onChoose: () => void;
}) {
  const open = day.expected.filter((e) => e.status === "expected");
  const resolved = day.expected.filter((e) => e.status !== "expected");
  const out = day.transactions
    .filter((t) => t.amountMinor > 0)
    .reduce((s, t) => s + t.amountMinor, 0);
  const inn = -day.transactions
    .filter((t) => t.amountMinor < 0)
    .reduce((s, t) => s + t.amountMinor, 0);
  return (
    <li
      data-agenda-day={day.date}
      className="border-b border-slate-200 last:border-b-0 dark:border-slate-700"
    >
      <button
        type="button"
        onClick={onChoose}
        aria-pressed={chosen}
        className={`sticky top-0 z-10 flex w-full flex-wrap items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm ${
          chosen
            ? "bg-blue-100 dark:bg-blue-900"
            : "bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700"
        }`}
      >
        <span className="flex items-center gap-2 font-medium">
          {longDay(day.date)}
          {day.date === today && (
            <span className="rounded-full bg-blue-600 px-2 text-xs text-white">Today</span>
          )}
        </span>
        <span className="flex gap-2 text-xs tabular-nums">
          {out > 0 && <span>−{formatMinor(out, "USD")}</span>}
          {inn > 0 && (
            <span className="text-green-700 dark:text-green-400">+{formatMinor(inn, "USD")}</span>
          )}
          {open.length > 0 && (
            <span className="text-violet-700 dark:text-violet-300">{open.length} expected</span>
          )}
        </span>
      </button>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {open.map((e) => (
          <ExpectedRow key={e.id} e={e} today={today} />
        ))}
        {day.transactions.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
              />
              <span className="truncate">{t.merchant}</span>
              <span className="hidden truncate text-xs text-slate-500 sm:inline dark:text-slate-400">
                {t.accountName}
              </span>
              {t.pending && (
                <span className="shrink-0 rounded-full bg-amber-100 px-2 text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                  Pending
                </span>
              )}
            </span>
            <span
              className={`shrink-0 tabular-nums ${t.amountMinor < 0 ? "font-medium text-green-700 dark:text-green-400" : ""}`}
            >
              {t.amountMinor < 0 ? "+" : "−"}
              {formatMinor(Math.abs(t.amountMinor), t.currency)}
            </span>
          </li>
        ))}
        {resolved.map((e) => (
          <ExpectedRow key={e.id} e={e} today={today} />
        ))}
      </ul>
    </li>
  );
}

/** An expected item: dashed and violet, with where it comes from and its state. */
function ExpectedRow({ e, today }: { e: CalendarEvent; today: string }) {
  const overdue = e.source === "planned" && e.status === "expected" && e.date < today;
  return (
    <li
      className={`flex items-center justify-between gap-3 px-3 py-1.5 text-sm ${
        e.status === "expected" ? "" : "opacity-60"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-violet-500"
        />
        <span className="truncate text-violet-900 dark:text-violet-200">{e.merchant}</span>
        <span className="shrink-0 rounded-full bg-violet-100 px-2 text-xs text-violet-900 dark:bg-violet-950 dark:text-violet-200">
          {e.source === "planned" ? "Planned" : "Pending manual"}
        </span>
        {overdue && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
            Past due
          </span>
        )}
        {e.status !== "expected" && (
          <span className="shrink-0 rounded-full bg-slate-200 px-2 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
            {e.status === "done" ? "Done" : "Skipped"}
          </span>
        )}
        {e.accountName && (
          <span className="hidden truncate text-xs text-slate-500 sm:inline dark:text-slate-400">
            {e.accountName}
          </span>
        )}
      </span>
      <span
        className={`shrink-0 tabular-nums ${e.direction === "in" ? "text-green-700 dark:text-green-400" : "text-violet-900 dark:text-violet-200"}`}
      >
        {e.direction === "in" ? "+" : "−"}
        {formatMinor(e.amountMinor, "USD")}
      </span>
    </li>
  );
}
