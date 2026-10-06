import { useState } from "react";
import { CalendarView } from "../components/calendar/CalendarView";
import { useApi } from "../hooks/useApi";
import type { Account } from "../types/api";

export function CalendarPage() {
  const [accountId, setAccountId] = useState("");
  const accounts = useApi<Account[]>("/accounts");

  return (
    <section className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            What happened each day and on which account. Click a day to see its transactions.
          </p>
        </div>
        <select
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
      <CalendarView accountId={accountId} />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Each colored dot is an account that had transactions that day. Totals here include
        transfers; the dashboard charts leave them out.
      </p>
    </section>
  );
}
