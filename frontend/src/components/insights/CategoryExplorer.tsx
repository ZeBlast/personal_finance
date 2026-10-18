import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../../hooks/useApi";
import { useCategories } from "../../hooks/useCategories";
import { colorAt } from "../charts/palette";
import {
  measureLabel,
  stackLayers,
  MEASURES,
  RANGES,
  measureValues,
  niceTicks,
  rangeFor,
  summarizeSeries,
  type ChartKind,
  type Interval,
  type Measure,
  type RangePreset,
  type Trends,
} from "../../lib/categoryTrends";
import { formatMinor } from "../../lib/money";
import type { Account, Category } from "../../types/api";
import { Select } from "../common/Select";

/** Everything the user can change, remembered on this computer between visits. */
interface Options {
  categories: number[];
  split: boolean;
  range: RangePreset;
  from: string;
  to: string;
  interval: Interval;
  measure: Measure;
  chart: ChartKind;
  cumulative: boolean;
  average: boolean;
  compare: boolean;
  pending: boolean;
  accounts: number[];
  hidden: string[];
}

/** The chart shows every transaction: each category's money out and money in as its own line. */
const FLOW = "all";

const DEFAULTS: Options = {
  categories: [],
  split: false,
  range: "12m",
  ...rangeFor("12m"),
  interval: "month",
  measure: "spending",
  chart: "line",
  cumulative: false,
  average: true,
  compare: false,
  pending: true,
  accounts: [],
  hidden: [],
};
const STORE = "pf.categoryExplorer.v1";

/**
 * The Transactions page filters for one period of the chart: the categories of the lines on show
 * (none when every line is), money in or out only when every line on show is that way, and the
 * account when exactly one is chosen. Pure, for testing.
 */
export function periodLink(input: {
  from: string;
  to: string;
  /** The lines on show: their categories (null is "Uncategorized") and which way the money went. */
  shown: Array<{ categoryId: number | null; direction?: "in" | "out" | undefined }>;
  /** Every line is on show (no category chosen, none hidden, not split). */
  everything: boolean;
  accounts: number[];
}): string {
  const params = new URLSearchParams({ from: input.from, to: input.to });
  if (!input.everything && input.shown.length > 0) {
    const ids = [
      ...new Set(input.shown.map((s) => (s.categoryId === null ? "none" : String(s.categoryId)))),
    ];
    params.set("category", ids.join(","));
    const ways = new Set(input.shown.map((s) => s.direction));
    const [way] = [...ways];
    if (ways.size === 1 && (way === "in" || way === "out")) params.set("direction", way);
  }
  if (input.accounts.length === 1) params.set("account", String(input.accounts[0]));
  return `/transactions?${params}`;
}

function load(): Options {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Options> | null;
    const merged = { ...DEFAULTS, ...(saved ?? {}) };
    // A preset always means "up to today", whenever the page is opened.
    return merged.range === "custom" ? merged : { ...merged, ...rangeFor(merged.range) };
  } catch {
    return DEFAULTS;
  }
}

const field =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900";

function Toggle({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex overflow-hidden rounded-md border border-slate-300 text-sm dark:border-slate-600"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`px-2.5 py-1 ${value === o.id ? "bg-blue-600 text-white" : "hover:bg-slate-100 dark:hover:bg-slate-800"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A dropdown of checkboxes, with search, closing on a click outside or Escape. */
function Picker({
  label,
  summary,
  children,
  search,
  onSearch,
}: {
  label: string;
  summary: string;
  children: ReactNode;
  search?: string;
  onSearch?: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={`${field} max-w-xs truncate text-left`}
      >
        {summary} ▾
      </button>
      {open && (
        <div className="absolute z-20 mt-1 max-h-80 w-72 overflow-auto rounded-md border border-slate-200 bg-white p-2 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {onSearch && (
            <input
              type="search"
              autoFocus
              value={search}
              placeholder="Search..."
              onChange={(e) => onSearch(e.target.value)}
              className={`${field} mb-2 w-full`}
            />
          )}
          {children}
        </div>
      )}
    </div>
  );
}

const money = (minor: number) => formatMinor(minor, "USD");
const formatFor = (measure: Measure) => (v: number) =>
  measure === "count"
    ? String(Math.round(v))
    : measure === "share"
      ? `${v.toFixed(v < 10 ? 1 : 0)}%`
      : money(v);
const axisFor = (measure: Measure) => (v: number) =>
  measure === "count"
    ? String(v)
    : measure === "share"
      ? `${v}%`
      : Math.abs(v) >= 100_000
        ? `$${Math.round(v / 100_000) / 10}k`
        : `$${Math.round(v / 100)}`;

/**
 * Spending by category over time, the way the user wants to see it: which categories (or their
 * subcategories), which period and in what steps, what to measure, how to draw it, with running
 * totals, an average, the period before, pending, and accounts as switches. Hover a period for its
 * figures, click it for its transactions; click a row of the table to hide or show its line.
 */
export function CategoryExplorer() {
  const id = useId();
  const navigate = useNavigate();
  const { categories } = useCategories();
  const accounts = useApi<Account[]>("/accounts");
  const [o, setO] = useState<Options>(load);
  const [catSearch, setCatSearch] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const set = (patch: Partial<Options>) => setO((prev) => ({ ...prev, ...patch }));
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(o));
    } catch {
      // Not remembered this time; everything still works.
    }
  }, [o]);

  const query = new URLSearchParams({
    from: o.from,
    to: o.to,
    interval: o.interval,
    categories: o.categories.join(","),
    accounts: o.accounts.join(","),
    split: o.split ? "1" : "0",
    pending: o.pending ? "1" : "0",
    flow: FLOW,
  });
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(o.from) && /^\d{4}-\d{2}-\d{2}$/.test(o.to) && o.from <= o.to;
  const trends = useApi<Trends>(valid ? `/analytics/category-trends?${query}` : null);
  const data = trends.data;

  const cats = categories ?? [];
  const tops = cats.filter((c) => c.parentId === null && c.active);
  const childrenOf = (p: number) => cats.filter((c) => c.parentId === p && c.active);
  const matches = (c: Category) => c.name.toLowerCase().includes(catSearch.trim().toLowerCase());
  const toggleCat = (cid: number) =>
    set({
      categories: o.categories.includes(cid)
        ? o.categories.filter((x) => x !== cid)
        : [...o.categories, cid],
      hidden: [],
    });

  const series = useMemo(() => {
    if (!data) return [];
    const used = new Map<string, number>();
    return data.series.map((s, i) => {
      // Two series with the same color (a subcategory takes its parent's) get a palette color.
      let color = s.color ?? colorAt(i);
      if (used.has(color)) color = colorAt(i + used.size);
      used.set(color, i);
      return {
        ...s,
        color,
        shown: measureValues(s, o.measure, data.allSpending, o.cumulative),
        summary: summarizeSeries(s, data.buckets, data.allSpending),
      };
    });
  }, [data, o.measure, o.cumulative]);
  const visible = series.filter((s) => !o.hidden.includes(s.key));

  // Chart geometry.
  const W = 760;
  const H = 280;
  const pad = { l: 56, r: 30, t: 12, b: 34 };
  const buckets = data?.buckets ?? [];
  const n = buckets.length;
  const stacked = o.chart === "stacked" || o.chart === "area";
  // Stacks grow up from zero for money out and down for money in (negative), each its own pile.
  const layers = stackLayers(
    visible.map((s) => s.shown),
    n,
  );
  const stackTotals = buckets.map((_, i) => visible.reduce((sum, s) => sum + (s.shown[i] ?? 0), 0));
  const values = stacked
    ? [...layers.up, ...layers.down]
    : visible.flatMap((s) => s.shown.filter((v): v is number => v !== null));
  const previousLines =
    o.compare && !o.cumulative && o.measure === "spending" && n > 0
      ? visible.map((s) => ({ key: s.key, color: s.color, value: Math.round(s.previousTotal / n) }))
      : [];
  const all = [...values, ...previousLines.map((p) => p.value), 0];
  const ticks = niceTicks(Math.min(...all), Math.max(...all, 1));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const x = (i: number) =>
    pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const slot = (W - pad.l - pad.r) / Math.max(1, n);
  const xBar = (i: number) => pad.l + i * slot;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const fmt = formatFor(o.measure);
  const axis = axisFor(o.measure);
  const bars = o.chart === "bars" || o.chart === "stacked";
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const centerOf = (i: number) => (bars ? xBar(i) + slot / 2 : x(i));

  // A period's transactions: in the categories of the lines on show (all of them, not only one).
  function openPeriod(i: number): void {
    const b = buckets[i];
    if (!b) return;
    navigate(
      periodLink({
        from: b.from,
        to: b.to,
        shown: visible,
        everything: o.categories.length === 0 && o.hidden.length === 0 && !o.split,
        accounts: o.accounts,
      }),
    );
  }

  const chosenLabel =
    o.categories.length === 0
      ? "All categories"
      : o.categories.length === 1
        ? (cats.find((c) => c.id === o.categories[0])?.name ?? "1 category")
        : `${o.categories.length} categories`;

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div>
        <h2 className="text-lg font-semibold">Transactions by category over time</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Every transaction, by category: each category&apos;s money out and money in are lines of
          their own (“· out” and “· in”), income and transfers between your accounts included.
          Spending counts up from zero and money coming in counts down below it. Hover a period for
          its figures, click it to see its transactions, and click a row below to hide or show its
          line.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Picker label="Categories" summary={chosenLabel} search={catSearch} onSearch={setCatSearch}>
          <div className="mb-1 flex gap-2 text-xs">
            <button
              type="button"
              className="hover:underline"
              onClick={() => set({ categories: [], hidden: [] })}
            >
              All (top level)
            </button>
          </div>
          {tops.map((p) => {
            const kids = childrenOf(p.id);
            const showParent = matches(p) || kids.some(matches);
            if (!showParent) return null;
            return (
              <div key={p.id}>
                <label className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={o.categories.includes(p.id)}
                    onChange={() => toggleCat(p.id)}
                  />
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: p.color ?? "#94a3b8" }}
                  />
                  <span className="font-medium">{p.name}</span>
                </label>
                {kids
                  .filter((k) => matches(k) || matches(p))
                  .map((k) => (
                    <label key={k.id} className="flex items-center gap-2 py-0.5 pl-5">
                      <input
                        type="checkbox"
                        checked={o.categories.includes(k.id)}
                        onChange={() => toggleCat(k.id)}
                      />
                      {k.name}
                    </label>
                  ))}
              </div>
            );
          })}
          {"uncategorized".includes(catSearch.trim().toLowerCase()) && (
            <label className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={o.categories.includes(0)}
                onChange={() => toggleCat(0)}
              />
              Uncategorized
            </label>
          )}
        </Picker>
        <Toggle
          label="Split into subcategories"
          checked={o.split}
          onChange={(v) => set({ split: v, hidden: [] })}
          title="Show each subcategory as its own line"
        />
        <Picker
          label="Accounts"
          summary={
            o.accounts.length === 0
              ? "All accounts"
              : `${o.accounts.length} account${o.accounts.length === 1 ? "" : "s"}`
          }
        >
          <button
            type="button"
            className="mb-1 text-xs hover:underline"
            onClick={() => set({ accounts: [] })}
          >
            All accounts
          </button>
          {(accounts.data ?? [])
            .filter((a) => a.type !== "investment")
            .map((a) => (
              <label key={a.id} className="flex items-center gap-2 py-0.5">
                <input
                  type="checkbox"
                  checked={o.accounts.includes(a.id)}
                  onChange={() =>
                    set({
                      accounts: o.accounts.includes(a.id)
                        ? o.accounts.filter((x) => x !== a.id)
                        : [...o.accounts, a.id],
                    })
                  }
                />
                {a.name}
              </label>
            ))}
        </Picker>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Period"
          value={o.range}
          options={RANGES}
          onChange={(r) => set(r === "custom" ? { range: r } : { range: r, ...rangeFor(r) })}
        />
        {o.range === "custom" && (
          <>
            <input
              type="date"
              aria-label="From"
              value={o.from}
              onChange={(e) => set({ from: e.target.value })}
              className={field}
            />
            <span className="text-sm">to</span>
            <input
              type="date"
              aria-label="To"
              value={o.to}
              onChange={(e) => set({ to: e.target.value })}
              className={field}
            />
          </>
        )}
        <Segmented
          label="Steps"
          value={o.interval}
          options={[
            { id: "week", label: "Weekly" },
            { id: "month", label: "Monthly" },
            { id: "quarter", label: "Quarterly" },
            { id: "year", label: "Yearly" },
          ]}
          onChange={(v) => set({ interval: v })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor={`${id}-measure`} className="text-sm">
          Show
        </label>
        <Select
          id={`${id}-measure`}
          value={o.measure}
          onChange={(e) => set({ measure: e.target.value as Measure })}
          className={field}
        >
          {MEASURES.map((m) => (
            <option key={m.id} value={m.id}>
              {measureLabel(m.id, FLOW)}
            </option>
          ))}
        </Select>
        <Segmented
          label="Chart"
          value={o.chart}
          options={[
            { id: "line", label: "Lines" },
            { id: "bars", label: "Bars" },
            { id: "stacked", label: "Stacked" },
            { id: "area", label: "Area" },
          ]}
          onChange={(v) => set({ chart: v })}
        />
        <Toggle
          label="Running total"
          checked={o.cumulative}
          onChange={(v) => set({ cumulative: v })}
          title="Add each period to the ones before it"
        />
        <Toggle label="Average line" checked={o.average} onChange={(v) => set({ average: v })} />
        <Toggle
          label="Compare with the period before"
          checked={o.compare}
          onChange={(v) => set({ compare: v })}
          title="Dashed: the period before's average per step (amount spent only)"
        />
        <Toggle label="Include pending" checked={o.pending} onChange={(v) => set({ pending: v })} />
      </div>

      {!valid && <p className="text-sm text-amber-700">Choose a start date before the end date.</p>}
      {trends.error && (
        <p role="alert" className="text-sm text-red-600">
          {trends.error}
        </p>
      )}

      {data && n > 0 && (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full select-none"
            role="img"
            aria-label={`${measureLabel(o.measure, FLOW)} by ${o.interval}, ${data.from} to ${data.to}`}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={pad.l}
                  x2={W - pad.r}
                  y1={y(t)}
                  y2={y(t)}
                  className="stroke-slate-200 dark:stroke-slate-700"
                  strokeWidth={t === 0 ? 1.2 : 0.6}
                />
                <text
                  x={pad.l - 6}
                  y={y(t) + 4}
                  textAnchor="end"
                  className="fill-slate-500 text-[10px]"
                >
                  {axis(t)}
                </text>
              </g>
            ))}
            {buckets.map((b, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={b.key}
                  x={centerOf(i)}
                  y={H - 12}
                  textAnchor="middle"
                  className="fill-slate-500 text-[10px]"
                >
                  {b.label.replace("Week of ", "")}
                </text>
              ) : null,
            )}

            {/* The series. */}
            {o.chart === "bars" &&
              visible.map((s, si) =>
                s.shown.map((v, i) =>
                  v === null ? null : (
                    <rect
                      key={`${s.key}-${i}`}
                      x={xBar(i) + slot * 0.1 + (si * slot * 0.8) / visible.length}
                      width={Math.max(1, (slot * 0.8) / visible.length - 1)}
                      y={Math.min(y(v), y(0))}
                      height={Math.abs(y(0) - y(v))}
                      fill={s.color}
                      opacity={hover === null || hover === i ? 0.9 : 0.5}
                    />
                  ),
                ),
              )}
            {stacked &&
              visible.map((s, si) => {
                const { lower, upper } = layers.series[si]!;
                if (o.chart === "stacked") {
                  return s.shown.map((v, i) =>
                    v === null || v === 0 ? null : (
                      <rect
                        key={`${s.key}-${i}`}
                        x={xBar(i) + slot * 0.15}
                        width={slot * 0.7}
                        y={Math.min(y(upper[i]!), y(lower[i]!))}
                        height={Math.abs(y(lower[i]!) - y(upper[i]!))}
                        fill={s.color}
                        opacity={hover === null || hover === i ? 0.9 : 0.55}
                      />
                    ),
                  );
                }
                const top = upper.map((v, i) => `${x(i)},${y(v)}`).join(" ");
                const bottom = lower
                  .map((v, i) => `${x(i)},${y(v)}`)
                  .reverse()
                  .join(" ");
                return (
                  <polygon key={s.key} points={`${top} ${bottom}`} fill={s.color} opacity={0.6} />
                );
              })}
            {o.chart === "line" &&
              visible.map((s) => {
                // A gap (no value) breaks the line; it starts again after.
                let d = "";
                let drawing = false;
                s.shown.forEach((v, i) => {
                  if (v === null) {
                    drawing = false;
                    return;
                  }
                  d += `${drawing ? " L" : " M"}${x(i)},${y(v)}`;
                  drawing = true;
                });
                return (
                  <g key={s.key}>
                    <path d={d} fill="none" stroke={s.color} strokeWidth={2} />
                    {n <= 40 &&
                      s.shown.map((v, i) =>
                        v === null ? null : (
                          <circle
                            key={i}
                            cx={x(i)}
                            cy={y(v)}
                            r={hover === i ? 4 : 2.5}
                            fill={s.color}
                          />
                        ),
                      )}
                  </g>
                );
              })}

            {o.average &&
              !stacked &&
              visible.map((s) => {
                const vals = s.shown.filter((v): v is number => v !== null);
                if (vals.length === 0 || o.cumulative) return null;
                const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                return (
                  <line
                    key={`avg-${s.key}`}
                    x1={pad.l}
                    x2={W - pad.r}
                    y1={y(avg)}
                    y2={y(avg)}
                    stroke={s.color}
                    strokeWidth={1}
                    strokeDasharray="2 3"
                    opacity={0.8}
                  />
                );
              })}
            {previousLines.map((p) => (
              <line
                key={`prev-${p.key}`}
                x1={pad.l}
                x2={W - pad.r}
                y1={y(p.value)}
                y2={y(p.value)}
                stroke={p.color}
                strokeWidth={1.4}
                strokeDasharray="7 5"
                opacity={0.7}
              />
            ))}

            {hover !== null && (
              <line
                x1={centerOf(hover)}
                x2={centerOf(hover)}
                y1={pad.t}
                y2={H - pad.b}
                className="stroke-slate-400"
                strokeWidth={0.8}
              />
            )}
            {/* Hover and click targets, one per period. */}
            {buckets.map((b, i) => (
              <rect
                key={`hit-${b.key}`}
                x={bars ? xBar(i) : x(i) - (W - pad.l - pad.r) / Math.max(1, n - 1) / 2}
                width={bars ? slot : (W - pad.l - pad.r) / Math.max(1, n - 1)}
                y={pad.t}
                height={H - pad.t - pad.b}
                fill="transparent"
                className="cursor-pointer"
                onPointerEnter={() => setHover(i)}
                onClick={() => openPeriod(i)}
              >
                <title>{`${b.label}: click to see its transactions`}</title>
              </rect>
            ))}
          </svg>

          {hover !== null && buckets[hover] && (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-md border border-slate-200 bg-white/95 p-2 text-xs shadow dark:border-slate-700 dark:bg-slate-900/95"
              style={centerOf(hover) / W > 0.6 ? { left: 8 } : { right: 8 }}
            >
              <div className="mb-1 font-semibold">{buckets[hover].label}</div>
              {visible.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                  <span className="tabular-nums">
                    {s.shown[hover] === null ? "—" : fmt(s.shown[hover]!)}
                    {o.measure === "spending" && !o.cumulative && ` · ${s.counts[hover]}×`}
                  </span>
                </div>
              ))}
              {stacked && visible.length > 1 && (
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-medium dark:border-slate-700">
                  <span title="Money out less money in">Net</span>
                  <span className="tabular-nums">{fmt(stackTotals[hover]!)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {data && n > 0 && data.series.length === 0 && (
        <p className="text-sm text-slate-500">No spending in these categories in this period.</p>
      )}

      {series.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-2">Category</th>
                <th className="py-1 pr-2 text-right">Spent</th>
                <th className="py-1 pr-2 text-right">Per {o.interval}</th>
                <th className="py-1 pr-2 text-right">Transactions</th>
                <th className="py-1 pr-2 text-right">Of all spending</th>
                <th className="py-1 pr-2">Highest</th>
                <th
                  className="py-1 text-right"
                  title={data ? `${data.previous.from} to ${data.previous.to}` : undefined}
                >
                  vs the period before
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {series.map((s) => {
                const off = o.hidden.includes(s.key);
                const c = s.summary.change;
                return (
                  <tr
                    key={s.key}
                    onClick={() =>
                      set({
                        hidden: off ? o.hidden.filter((k) => k !== s.key) : [...o.hidden, s.key],
                      })
                    }
                    className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 ${off ? "opacity-40" : ""}`}
                    title={off ? "Click to show its line" : "Click to hide its line"}
                  >
                    <td className="py-1 pr-2">
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        {s.label}
                        <button
                          type="button"
                          className="text-xs text-slate-500 hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            set({
                              hidden: series.filter((x) => x.key !== s.key).map((x) => x.key),
                            });
                          }}
                        >
                          only
                        </button>
                      </span>
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{money(s.summary.total)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {money(s.summary.perPeriod)}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{s.summary.count}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {s.summary.share === null ? "—" : `${s.summary.share.toFixed(1)}%`}
                    </td>
                    <td className="py-1 pr-2 text-xs">
                      {s.summary.highest
                        ? `${s.summary.highest.label} (${money(s.summary.highest.value)})`
                        : "—"}
                    </td>
                    <td
                      className={`py-1 text-right tabular-nums ${c === null ? "" : c > 0 ? "text-red-600" : "text-green-700 dark:text-green-400"}`}
                    >
                      {c === null ? "—" : `${c > 0 ? "+" : ""}${c.toFixed(0)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {o.hidden.length > 0 && (
            <button
              type="button"
              className="mt-1 text-xs hover:underline"
              onClick={() => set({ hidden: [] })}
            >
              Show all lines
            </button>
          )}
        </div>
      )}
    </section>
  );
}
