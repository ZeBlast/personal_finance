import { useEffect, useRef, useState } from "react";
import { AgendaView } from "../components/calendar/AgendaView";
import { spanTitle } from "../components/calendar/range";
import { usePersistentState } from "../hooks/usePersistentState";
import { setDateBasis, useDateBasis } from "../hooks/useDateBasis";
import { CalendarBoard } from "../components/calendar/CalendarBoard";
import { DayPanel } from "../components/calendar/DayPanel";
import type { DaySpan } from "../components/calendar/range";
import { useApi } from "../hooks/useApi";
import { useCategories } from "../hooks/useCategories";
import { today } from "../lib/period";
import type { Account } from "../types/api";
import { Select } from "../components/common/Select";

export function CalendarPage() {
  const basis = useDateBasis();
  const todayDay = today();
  const [accountId, setAccountId] = useState("");
  const [selection, setSelection] = useState<DaySpan | null>({ from: todayDay, to: todayDay });
  const accounts = useApi<Account[]>("/accounts");
  const { categories } = useCategories();
  const [view, setView] = usePersistentState<"month" | "agenda">("pf.calendar.view", "month");
  // In a narrow window the panel sits below the calendar: a button leads to it while it is out
  // of sight.
  const panel = useRef<HTMLDivElement>(null);
  const [panelInView, setPanelInView] = useState(true);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const watch = new IntersectionObserver(
      ([entry]) => setPanelInView(entry?.isIntersecting ?? true),
      {
        threshold: 0.15,
      },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The selection stays while other controls are used; the panel's Clear (or Escape on the
  // calendar) clears it.

  return (
    <section className="flex h-full min-h-[36rem] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            What happened each day, what you expect, and your notes. Click a day, or drag across
            several, to see the balance and what changed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Show as"
            className="inline-flex overflow-hidden rounded border border-slate-300 text-sm dark:border-slate-600"
          >
            {(
              [
                ["month", "Month"],
                ["agenda", "Agenda"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setView(value)}
                className={`px-3 py-2 ${
                  view === value
                    ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                    : "bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            data-keep-selection
            role="group"
            aria-label="Place transactions by"
            className="inline-flex overflow-hidden rounded border border-slate-300 text-sm dark:border-slate-600"
          >
            {(
              [
                ["transaction", "Transaction date"],
                ["posted", "Posted date"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={basis === value}
                onClick={() => setDateBasis(value)}
                className={`px-3 py-2 ${
                  basis === value
                    ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                    : "bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Select
            data-keep-selection
            aria-label="Account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
          >
            <option value="">All accounts</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-h-[30rem] min-w-0 lg:min-h-0">
          {view === "agenda" ? (
            <AgendaView accountId={accountId} selection={selection} onSelect={setSelection} />
          ) : (
            <CalendarBoard accountId={accountId} selection={selection} onSelect={setSelection} />
          )}
        </div>
        <div ref={panel} className="flex min-w-0 flex-col lg:min-h-0">
          {selection ? (
            <DayPanel
              span={selection}
              accountId={accountId}
              accounts={accounts.data ?? []}
              categories={categories ?? []}
              today={todayDay}
              onClear={() => setSelection(null)}
              onPickDay={(day) => setSelection({ from: day, to: day })}
            />
          ) : (
            <aside
              aria-label="Selected days"
              className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-400"
            >
              Choose a day to see its balance, what changed, its transactions and note, and to add a
              transaction or an expected one. Drag across days to total up a span.
            </aside>
          )}
        </div>
      </div>
      {selection && !panelInView && (
        <button
          type="button"
          onClick={() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="fixed right-4 bottom-4 z-30 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-blue-700 lg:hidden"
        >
          Details for {spanTitle(selection)} ↓
        </button>
      )}
    </section>
  );
}
