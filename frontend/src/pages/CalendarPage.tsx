import { useEffect, useState } from "react";
import { setDateBasis, useDateBasis } from "../hooks/useDateBasis";
import { CalendarBoard } from "../components/calendar/CalendarBoard";
import { DayPanel } from "../components/calendar/DayPanel";
import type { DaySpan } from "../components/calendar/range";
import { useApi } from "../hooks/useApi";
import { useCategories } from "../hooks/useCategories";
import { today } from "../lib/period";
import type { Account } from "../types/api";

export function CalendarPage() {
  const basis = useDateBasis();
  const todayDay = today();
  const [accountId, setAccountId] = useState("");
  const [selection, setSelection] = useState<DaySpan | null>({ from: todayDay, to: todayDay });
  const accounts = useApi<Account[]>("/accounts");
  const { categories } = useCategories();

  // Clicking anywhere outside the calendar and its panel deselects the day or days. A note being
  // typed is saved by its box on the way out, so nothing typed is lost.
  useEffect(() => {
    if (selection === null) return;
    const onPress = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-keep-selection], [role=dialog]")) return;
      setSelection(null);
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, [selection]);

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
          <select
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
          </select>
        </div>
      </div>

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-h-[30rem] min-w-0 lg:min-h-0">
          <CalendarBoard accountId={accountId} selection={selection} onSelect={setSelection} />
        </div>
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
    </section>
  );
}
