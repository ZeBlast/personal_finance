import { useEffect, useState } from "react";
import { usePersistentState } from "../hooks/usePersistentState";
import { NetworkGraph } from "../components/graph/NetworkGraph";
import { useApi } from "../hooks/useApi";
import type { GraphData } from "../lib/graph/model";
import { today } from "../lib/period";
import { Loading } from "../components/common/Loading";

type GraphResponse = GraphData & { truncated: boolean; from: string; to: string };

type RangeId = "day" | "week" | "30" | "90" | "365" | "custom";

const RANGES: Array<{ id: RangeId; label: string; days?: number }> = [
  { id: "day", label: "Day", days: 0 },
  { id: "week", label: "Week", days: 6 },
  { id: "30", label: "30 days", days: 29 },
  { id: "90", label: "90 days", days: 89 },
  { id: "365", label: "1 year", days: 364 },
  { id: "custom", label: "Custom" },
];

const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return today(d);
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Institutions, accounts, and transactions as a graph you can explore, after Obsidian's graph view. */
export function NetworkPage() {
  // Remembered, so leaving the page and coming back keeps the same view.
  const [savedRange, setRange] = usePersistentState<RangeId>("pf.network.range", "30");
  const range: RangeId = RANGES.some((r) => r.id === savedRange) ? savedRange : "30";
  const [custom, setCustom] = usePersistentState("pf.network.custom", () => ({
    from: daysAgo(29),
    to: today(),
  }));

  const preset = RANGES.find((r) => r.id === range)!;
  const customOk = DATE.test(custom.from) && DATE.test(custom.to) && custom.from <= custom.to;
  const from = range === "custom" ? custom.from : daysAgo(preset.days ?? 0);
  const to = range === "custom" ? custom.to : today();
  const { data, error } = useApi<GraphResponse>(
    range === "custom" && !customOk ? null : `/graph/transactions?from=${from}&to=${to}`,
  );

  // Keep showing the last graph while another period loads, so the graph (and its filters,
  // forces, and layout) stays put instead of starting over.
  const [shown, setShown] = useState<GraphResponse | null>(null);
  useEffect(() => {
    if (data) setShown(data);
  }, [data]);
  const loadingNew = shown !== null && (data === null || data.from !== from || data.to !== to);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Network</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Your institutions, their accounts, and where the money went. Drag to move around, scroll
            to zoom, hover to see what connects.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Period"
            className="flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-600"
          >
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
                className={`px-3 py-1.5 text-sm ${range === r.id ? "bg-blue-600 text-white" : "hover:bg-slate-100 dark:hover:bg-slate-700"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          {range === "custom" && (
            <div className="flex items-center gap-1 text-sm">
              <label className="sr-only" htmlFor="network-from">
                From
              </label>
              <input
                id="network-from"
                type="date"
                value={custom.from}
                max={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
              />
              <span aria-hidden="true">to</span>
              <label className="sr-only" htmlFor="network-to">
                To
              </label>
              <input
                id="network-to"
                type="date"
                value={custom.to}
                min={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
              />
            </div>
          )}
        </div>
      </div>
      {range === "custom" && !customOk && (
        <p role="alert" className="text-sm text-red-600">
          Choose a start date on or before the end date.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {!shown && !error && <Loading />}
      {shown?.truncated && (
        <p className="text-sm text-amber-700">
          Only the newest {shown.transactions.length} transactions are shown. Choose a shorter
          period to see them all.
        </p>
      )}
      {shown && (
        <div className="relative">
          <NetworkGraph data={shown} />
          {loadingNew && (
            <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-slate-900/80 px-3 py-1 text-xs text-white">
              Loading...
            </p>
          )}
        </div>
      )}
    </section>
  );
}
