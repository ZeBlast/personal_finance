import { useMemo, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { today } from "../../lib/period";
import { formatDay } from "../../lib/time";
import type { UtilizationHistory } from "../../types/insights";
import { Select } from "../common/Select";
import { UtilizationChart } from "./UtilizationChart";

const RANGES = [
  { value: "90", label: "3 months" },
  { value: "365", label: "12 months" },
  { value: "36500", label: "Everything" },
];

/** `YYYY-MM-DD` this many days before `day`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export function UtilizationSection() {
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
          <Select
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
          </Select>
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
