import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { formatMinor } from "../../lib/money";
import {
  MARYLAND_COUNTIES,
  STATE_CHOICES,
  VIRGINIA_VEHICLE_LOCALITIES,
  type StateCode,
} from "../../lib/sandbox/dmvTaxes";
import {
  computeFlow,
  defaultFlow,
  isAutoLink,
  projectGrowth,
  type FlowGraph,
  type FlowKind,
  type FlowLink,
  type FlowNode,
  type CustomTax,
  type FlowTaxType,
} from "../../lib/sandbox/flow";
import {
  GRID,
  resizeFromBottomLeft,
  routeLink,
  routeToPoint,
  snap,
} from "../../lib/sandbox/flowGeometry";
import { newId } from "../../lib/sandbox/graph";
import { parseBrackets } from "../../lib/sandbox/brackets";
import { FILING_STATUSES, type FilingStatus } from "../../lib/sandbox/taxes";
import { LineChart } from "../charts/LineChart";
import { SavedMaps } from "./SavedMaps";
import { Select } from "../common/Select";
import { Loading } from "../common/Loading";
import { toast } from "../../lib/toast";

/**
 * The cash-flow map (experimental): buckets of money and the amounts flowing between them. Drag a
 * bucket to move it; drag from its right-hand dot onto another bucket to send money there; click a
 * bucket or a flow to change it. Flows into taxes and into "what's left" work themselves out.
 */

const CARD_W = 216;
const CARD_H = 120;

const KINDS: Array<{ kind: FlowKind; label: string; color: string; hint: string }> = [
  { kind: "income", label: "Income", color: "#0ea5e9", hint: "Pay or other money coming in." },
  {
    kind: "tax",
    label: "Tax",
    color: "#ef4444",
    hint: "Works itself out from the income flowing in.",
  },
  {
    kind: "pretax",
    label: "Pre-tax",
    color: "#14b8a6",
    hint: "401(k), TSP, HSA, health plan: taken before tax.",
  },
  { kind: "spending", label: "Spending", color: "#f59e0b", hint: "Rent, food, bills." },
  {
    kind: "savings",
    label: "Savings",
    color: "#22c55e",
    hint: "Savings and investments, with growth.",
  },
  {
    kind: "leftover",
    label: "Bucket",
    color: "#a855f7",
    hint: "Collects the remainder of each bucket flowing into it (what that bucket has not sent elsewhere), added together.",
  },
];
const colorOf = (kind: FlowKind) => KINDS.find((k) => k.kind === kind)!.color;

const PERIODS = [
  { value: 1, label: "per year" },
  { value: 12, label: "per month" },
  { value: 26, label: "every 2 weeks" },
];
const TAX_TYPES: Array<{ value: FlowTaxType; label: string }> = [
  { value: "federal", label: "Federal income tax" },
  { value: "state", label: "State income tax (MD, DC, VA)" },
  { value: "local", label: "Maryland county income tax" },
  { value: "fica", label: "FICA (Social Security 6.2% + Medicare 1.45%)" },
  { value: "fers", label: "FERS (federal retirement, 4.4%)" },
  { value: "vehicle", label: "Virginia car tax" },
  { value: "custom", label: "Custom tax (your own rate, amount, or brackets)" },
];

interface Saved extends FlowGraph {
  view?: { x: number; y: number; zoom: number };
  settings?: { period?: number; years?: number };
}

export function FlowMap() {
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [view, setView] = useState({ x: 20, y: 20, zoom: 0.66 });
  const [period, setPeriod] = useState(1);
  const [years, setYears] = useState(10);
  const [selected, setSelected] = useState<{ kind: "node" | "link"; id: string } | null>(null);
  const [pending, setPending] = useState<{ from: string; x: number; y: number } | null>(null);
  const [dragLink, setDragLink] = useState<{
    id: string;
    x: number;
    y: number;
    over: string | null;
  } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const outer = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    void api<Saved | null>("/sandbox/flow")
      .then((s) => {
        setGraph(s ? { nodes: s.nodes, links: s.links } : defaultFlow());
        if (s?.view) setView(s.view);
        if (s?.settings?.period) setPeriod(s.settings.period);
        if (s?.settings?.years) setYears(s.settings.years);
      })
      .catch(() => setGraph(defaultFlow()))
      .finally(() => {
        loaded.current = true;
      });
  }, []);

  useEffect(() => {
    if (!graph || !loaded.current) return;
    setSaveState("saving");
    const timer = setTimeout(() => {
      api("/sandbox/flow", {
        method: "PUT",
        body: JSON.stringify({ ...graph, view, settings: { period, years } }),
      })
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [graph, view, period, years]);

  const result = useMemo(() => (graph ? computeFlow(graph) : null), [graph]);
  const growth = useMemo(
    () => (graph && result ? projectGrowth(graph, result, years) : []),
    [graph, result, years],
  );

  // Wheel zooms around the mouse.
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const mx = e.clientX - box.left;
      const my = e.clientY - box.top;
      setView((v) => {
        const zoom = Math.min(2, Math.max(0.3, v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        return { zoom, x: mx - ((mx - v.x) * zoom) / v.zoom, y: my - ((my - v.y) * zoom) / v.zoom };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [graph === null]);

  if (!graph || !result) return <Loading />;

  const money = (yearly: number) => formatMinor(Math.round((yearly / period) * 100), "USD");
  const update = (change: (g: FlowGraph) => FlowGraph) => setGraph((g) => (g ? change(g) : g));
  const setNode = (id: string, change: Partial<FlowNode>) =>
    update((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) }));
  const setLink = (id: string, change: Partial<FlowLink>) =>
    update((g) => ({ ...g, links: g.links.map((l) => (l.id === id ? { ...l, ...change } : l)) }));

  const toCanvas = (cx: number, cy: number) => {
    const box = outer.current!.getBoundingClientRect();
    return { x: (cx - box.left - view.x) / view.zoom, y: (cy - box.top - view.y) / view.zoom };
  };
  const track = (move: (e: PointerEvent) => void, up?: (e: PointerEvent) => void) => {
    const m = (e: PointerEvent) => move(e);
    const u = (e: PointerEvent) => {
      window.removeEventListener("pointermove", m);
      window.removeEventListener("pointerup", u);
      up?.(e);
    };
    window.addEventListener("pointermove", m);
    window.addEventListener("pointerup", u);
  };

  const addNode = (kind: FlowKind) => {
    const box = outer.current?.getBoundingClientRect();
    const id = newId("f");
    const label = KINDS.find((k) => k.kind === kind)!.label;
    const node: FlowNode = {
      id,
      kind,
      label: kind === "leftover" ? "Bucket" : `New ${label.toLowerCase()}`,
      x: snap(((box?.width ?? 800) / 2 - view.x) / view.zoom - CARD_W / 2),
      y: snap(((box?.height ?? 500) / 2 - view.y) / view.zoom - CARD_H / 2),
      ...(kind === "income" ? { amount: 50_000 } : {}),
      ...(kind === "tax" ? { tax: { type: "federal" as const } } : {}),
      ...(kind === "savings" ? { apy: 4 } : {}),
    };
    update((g) => ({ ...g, nodes: [...g.nodes, node] }));
    setSelected({ kind: "node", id });
  };

  const connect = (from: string, to: string) => {
    if (from === to) return;
    update((g) => {
      const target = g.nodes.find((n) => n.id === to);
      if (!target || target.kind === "income") return g;
      if (g.links.some((l) => l.from === from && l.to === to)) return g;
      const link: FlowLink = { id: newId("l"), from, to };
      if (target.kind !== "tax" && target.kind !== "leftover") link.amount = 1_000;
      setSelected({ kind: "link", id: link.id });
      return { ...g, links: [...g.links, link] };
    });
  };

  const maxFlow = Math.max(1, ...Object.values(result.linkAmounts));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const boxOf = (n: FlowNode) => ({ x: n.x, y: n.y, w: n.w ?? CARD_W, h: n.h ?? CARD_H });

  /** Under the pointer: a bucket's id, or null. */
  const bucketAt = (clientX: number, clientY: number): string | null =>
    document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-flow-node]")?.dataset[
      "flowNode"
    ] ?? null;

  /**
   * Pressing on a flow: a click selects it; dragging it away and letting go deletes it, or moves its
   * end onto another bucket when dropped on one.
   */
  const pressLink = (e: React.PointerEvent, link: FlowLink) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    track(
      (m) => {
        if (!dragging && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 8) return;
        dragging = true;
        const p = toCanvas(m.clientX, m.clientY);
        const over = bucketAt(m.clientX, m.clientY);
        setDragLink({ id: link.id, ...p, over });
      },
      (u) => {
        setDragLink(null);
        if (!dragging) {
          setSelected({ kind: "link", id: link.id });
          return;
        }
        const over = bucketAt(u.clientX, u.clientY);
        if (over === link.to) return; // dropped back where it was
        if (over && over !== link.from) {
          update((g) => {
            const target = g.nodes.find((n) => n.id === over);
            const duplicate = g.links.some((l) => l.from === link.from && l.to === over);
            if (!target || target.kind === "income" || duplicate) return g;
            return { ...g, links: g.links.map((l) => (l.id === link.id ? { ...l, to: over } : l)) };
          });
          return;
        }
        update((g) => ({ ...g, links: g.links.filter((l) => l.id !== link.id) }));
        setSelected(null);
      },
    );
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-slate-500">Add:</span>
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              title={k.hint}
              onClick={() => addNode(k.kind)}
              className="rounded-full border px-2.5 py-0.5 text-xs font-medium"
              style={{ borderColor: k.color, color: k.color }}
            >
              + {k.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-2">
            <Select
              aria-label="Show amounts"
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
            >
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  Amounts {p.label}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={() => {
                const before = { graph, view };
                setGraph(defaultFlow());
                setView({ x: 20, y: 20, zoom: 0.66 });
                setSelected(null);
                toast("Replaced the map with the example.", {
                  action: {
                    label: "Undo",
                    run: () => {
                      setGraph(before.graph);
                      setView(before.view);
                    },
                  },
                });
              }}
              className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
            >
              Example
            </button>
            <SavedMaps
              kind="flow"
              getData={() => ({
                nodes: graph.nodes,
                links: graph.links,
                view,
                settings: { period, years },
              })}
              onLoad={(data) => {
                const saved = data as unknown as Saved;
                setGraph({ nodes: saved.nodes ?? [], links: saved.links ?? [] });
                if (saved.view) setView(saved.view);
                if (saved.settings?.period) setPeriod(saved.settings.period);
                if (saved.settings?.years) setYears(saved.settings.years);
                setSelected(null);
              }}
            />
            <span className="text-xs text-slate-500" aria-live="polite">
              {saveState === "saving" ? "Saving..." : saveState === "error" ? "Not saved" : "Saved"}
            </span>
          </span>
        </div>

        <div
          ref={outer}
          onPointerDown={(e) => {
            if (e.button !== 0 || e.target !== e.currentTarget) return;
            setSelected(null);
            const s = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
            track((m) =>
              setView((v) => ({ ...v, x: s.vx + m.clientX - s.x, y: s.vy + m.clientY - s.y })),
            );
          }}
          className="relative min-h-[28rem] flex-1 cursor-grab touch-none overflow-hidden rounded-lg border border-slate-200 bg-slate-50 select-none dark:border-slate-700 dark:bg-slate-950"
          style={{
            backgroundImage: "radial-gradient(circle, rgb(148 163 184 / 0.3) 1px, transparent 1px)",
            backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        >
          <div
            className="pointer-events-none absolute top-0 left-0 origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          >
            <svg
              className="pointer-events-none absolute top-0 left-0 overflow-visible"
              width="1"
              height="1"
            >
              {graph.links.map((l) => {
                const a = nodeById.get(l.from);
                const b = nodeById.get(l.to);
                if (!a || !b) return null;
                const amount = result.linkAmounts[l.id] ?? 0;
                if (dragLink?.id === l.id) return null; // drawn following the pointer below
                const { d, mid, start, end } = routeLink(boxOf(a), boxOf(b));
                const width = 2 + 12 * Math.sqrt(amount / maxFlow);
                const isSel = selected?.kind === "link" && selected.id === l.id;
                const grad = `flow-grad-${l.id}`;
                return (
                  <g key={l.id}>
                    <defs>
                      <linearGradient
                        id={grad}
                        gradientUnits="userSpaceOnUse"
                        x1={start.x}
                        y1={start.y}
                        x2={end.x}
                        y2={end.y}
                      >
                        <stop offset="0%" stopColor={colorOf(a.kind)} />
                        <stop offset="100%" stopColor={colorOf(b.kind)} />
                      </linearGradient>
                    </defs>
                    <path
                      d={d}
                      stroke={`url(#${grad})`}
                      strokeOpacity={isSel ? 0.6 : 0.28}
                      strokeWidth={width}
                      fill="none"
                    />
                    <path
                      d={d}
                      stroke={`url(#${grad})`}
                      strokeWidth={Math.max(1.5, width / 3)}
                      strokeDasharray="6 14"
                      fill="none"
                      className="pf-flow-dash"
                    />
                    <path
                      d={d}
                      stroke="transparent"
                      strokeWidth={Math.max(14, width)}
                      fill="none"
                      className="pointer-events-auto cursor-grab"
                      onPointerDown={(e) => pressLink(e, l)}
                    >
                      <title>{`${a.label} → ${b.label}: ${money(amount)}. Click to change; drag away and drop to delete.`}</title>
                    </path>
                    <text
                      x={mid.x}
                      y={mid.y - 6}
                      textAnchor="middle"
                      className="fill-slate-600 text-[11px] font-medium dark:fill-slate-300"
                      style={{ paintOrder: "stroke" }}
                      stroke="var(--pf-label-halo, #f8fafc)"
                      strokeWidth={3}
                    >
                      {money(amount)}
                      {isAutoLink(graph, l) ? " ⚙" : ""}
                    </text>
                  </g>
                );
              })}
              {pending && nodeById.get(pending.from) && (
                <path
                  d={routeToPoint(boxOf(nodeById.get(pending.from)!), pending)}
                  stroke="#94a3b8"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  fill="none"
                />
              )}
              {dragLink &&
                (() => {
                  const link = graph.links.find((l) => l.id === dragLink.id);
                  const a = link && nodeById.get(link.from);
                  if (!link || !a) return null;
                  const deleting = !dragLink.over || dragLink.over === link.from;
                  const target = dragLink.over ? nodeById.get(dragLink.over) : undefined;
                  const refused =
                    !deleting &&
                    dragLink.over !== link.to &&
                    (target?.kind === "income" ||
                      graph.links.some((l) => l.from === link.from && l.to === dragLink.over));
                  return (
                    <g>
                      <path
                        d={routeToPoint(boxOf(a), dragLink)}
                        stroke={deleting ? "#ef4444" : "#94a3b8"}
                        strokeWidth={3}
                        strokeDasharray="6 4"
                        fill="none"
                      />
                      <text
                        x={dragLink.x + 12}
                        y={dragLink.y - 10}
                        className={`text-[12px] font-semibold ${deleting ? "fill-red-600" : "fill-slate-600 dark:fill-slate-300"}`}
                      >
                        {deleting
                          ? "Let go to delete"
                          : dragLink.over === link.to
                            ? "Let go to keep it"
                            : refused
                              ? target?.kind === "income"
                                ? "Money cannot flow into income"
                                : "Already connected here"
                              : "Let go to send it here"}
                      </text>
                    </g>
                  );
                })()}
            </svg>

            {graph.nodes.map((n) => (
              <FlowCard
                key={n.id}
                node={n}
                amount={money(result.nodeAmounts[n.id] ?? 0)}
                overspent={
                  result.overspent[n.id] !== undefined ? money(result.overspent[n.id]!) : null
                }
                selected={selected?.kind === "node" && selected.id === n.id}
                zoom={view.zoom}
                onSelect={() => setSelected({ kind: "node", id: n.id })}
                onMove={(x, y) => setNode(n.id, { x, y })}
                onResize={(change) => setNode(n.id, change)}
                onRename={(label) => setNode(n.id, { label })}
                onRemove={() => {
                  update((g) => ({
                    nodes: g.nodes.filter((x) => x.id !== n.id),
                    links: g.links.filter((l) => l.from !== n.id && l.to !== n.id),
                  }));
                  setSelected(null);
                }}
                onConnectStart={(e) => {
                  setPending({ from: n.id, ...toCanvas(e.clientX, e.clientY) });
                  track(
                    (m) => setPending((p) => (p ? { ...p, ...toCanvas(m.clientX, m.clientY) } : p)),
                    (u) => {
                      setPending(null);
                      const hit = bucketAt(u.clientX, u.clientY);
                      if (hit) connect(n.id, hit);
                    },
                  );
                }}
                track={track}
              />
            ))}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Experimental. Drag a bucket to move it; drag from its colored dot onto another bucket to
          send money there; click a bucket or a flow to change it, or drag a flow away and drop it
          to delete it. ⚙ flows work themselves out. Thicker flows carry more money. Scroll to zoom,
          drag the background to move around.
        </p>
      </div>

      <aside className="w-80 shrink-0 space-y-3 overflow-y-auto text-sm">
        {selected?.kind === "node" && nodeById.get(selected.id) ? (
          <NodeEditor
            node={nodeById.get(selected.id)!}
            amount={result.nodeAmounts[selected.id] ?? 0}
            money={money}
            onChange={(c) => setNode(selected.id, c)}
            onDelete={() => {
              update((g) => ({
                nodes: g.nodes.filter((n) => n.id !== selected.id),
                links: g.links.filter((l) => l.from !== selected.id && l.to !== selected.id),
              }));
              setSelected(null);
            }}
          />
        ) : selected?.kind === "link" && graph.links.find((l) => l.id === selected.id) ? (
          <LinkEditor
            graph={graph}
            link={graph.links.find((l) => l.id === selected.id)!}
            amount={result.linkAmounts[selected.id] ?? 0}
            money={money}
            onChange={(c) => setLink(selected.id, c)}
            onDelete={() => {
              update((g) => ({ ...g, links: g.links.filter((l) => l.id !== selected.id) }));
              setSelected(null);
            }}
          />
        ) : (
          <Summary result={result} money={money} />
        )}
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="font-semibold">Savings growth</h3>
            <Select
              aria-label="Years to project"
              value={years}
              onChange={(e) => setYears(Number(e.target.value))}
              className="rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600"
            >
              {[5, 10, 20, 30].map((y) => (
                <option key={y} value={y}>
                  {y} years
                </option>
              ))}
            </Select>
          </div>
          <LineChart
            series={[
              {
                key: "total",
                label: "Savings and pre-tax accounts",
                color: "#22c55e",
                points: growth.map((p) => ({
                  date: `${2026 + p.year}-01-01`,
                  value: Math.round(p.total * 100),
                })),
              },
            ]}
            format={(v) => formatMinor(v, "USD")}
          />
          <p className="mt-1 text-xs text-slate-500">
            {formatMinor(Math.round((growth.at(-1)?.total ?? 0) * 100), "USD")} after {years} years,
            with each account&apos;s growth rate (set it on the bucket) compounded monthly.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Summary({
  result,
  money,
}: {
  result: ReturnType<typeof computeFlow>;
  money: (n: number) => string;
}) {
  const t = result.totals;
  const rows: Array<[string, number, FlowKind]> = [
    ["Income", t.income, "income"],
    ["Taxes", t.taxes, "tax"],
    ["Pre-tax", t.pretax, "pretax"],
    ["Spending", t.spending, "spending"],
    ["Savings", t.savings, "savings"],
    ["Left in buckets", t.leftover, "leftover"],
  ];
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="font-semibold">Where the money goes</h3>
      {rows.map(([label, value, kind]) => (
        <div key={label}>
          <div className="flex justify-between">
            <span>{label}</span>
            <span className="font-medium tabular-nums">{money(value)}</span>
          </div>
          {kind !== "income" && t.income > 0 && (
            <div className="mt-0.5 h-1.5 rounded bg-slate-100 dark:bg-slate-800">
              <div
                className="h-1.5 rounded"
                style={{
                  width: `${Math.min(100, (value / t.income) * 100)}%`,
                  backgroundColor: colorOf(kind),
                }}
              />
            </div>
          )}
        </div>
      ))}
      <div className="flex justify-between border-t border-slate-100 pt-2 text-xs dark:border-slate-800">
        <span>Taxes take {(t.effectiveTaxRate * 100).toFixed(1)}%</span>
        <span>Saving {(t.savingsRate * 100).toFixed(1)}%</span>
      </div>
      <p className="text-xs text-slate-500">Click a bucket or a flow to change it.</p>
    </div>
  );
}

const field =
  "w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800";

function NodeEditor({
  node,
  amount,
  money,
  onChange,
  onDelete,
}: {
  node: FlowNode;
  amount: number;
  money: (n: number) => string;
  onChange: (c: Partial<FlowNode>) => void;
  onDelete: () => void;
}) {
  const tax = node.tax ?? { type: "federal" as FlowTaxType };
  const setTax = (c: Partial<NonNullable<FlowNode["tax"]>>) => onChange({ tax: { ...tax, ...c } });
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{KINDS.find((k) => k.kind === node.kind)!.label}</h3>
        <span className="font-bold tabular-nums">{money(amount)}</span>
      </div>
      <label className="block">
        Name
        <input
          value={node.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className={field}
        />
      </label>
      {node.kind === "income" && (
        <label className="block">
          Per year
          <input
            type="number"
            value={node.amount ?? 0}
            onChange={(e) => onChange({ amount: Number(e.target.value) })}
            className={field}
          />
        </label>
      )}
      {node.kind === "tax" && (
        <>
          <label className="block">
            Kind of tax
            <Select
              value={tax.type}
              onChange={(e) => setTax({ type: e.target.value as FlowTaxType })}
              className={field}
            >
              {TAX_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </label>
          {tax.type !== "vehicle" && tax.type !== "fers" && tax.type !== "custom" && (
            <label className="block">
              Filing status
              <Select
                value={tax.status ?? "single"}
                onChange={(e) => setTax({ status: e.target.value as FilingStatus })}
                className={field}
              >
                {FILING_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {tax.type === "state" && (
            <label className="block">
              State
              <Select
                value={tax.state ?? "VA"}
                onChange={(e) => setTax({ state: e.target.value as StateCode })}
                className={field}
              >
                {STATE_CHOICES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {tax.type === "local" && (
            <label className="block">
              County
              <Select
                value={tax.county ?? "montgomery"}
                onChange={(e) => setTax({ county: e.target.value })}
                className={field}
              >
                {MARYLAND_COUNTIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {tax.type === "vehicle" && (
            <>
              <label className="block">
                County
                <Select
                  value={tax.locality ?? "fairfax_county"}
                  onChange={(e) => setTax({ locality: e.target.value })}
                  className={field}
                >
                  {VIRGINIA_VEHICLE_LOCALITIES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                Vehicle value
                <input
                  type="number"
                  value={tax.vehicleValue ?? 0}
                  onChange={(e) => setTax({ vehicleValue: Number(e.target.value) })}
                  className={field}
                />
              </label>
              {VIRGINIA_VEHICLE_LOCALITIES.find((l) => l.id === (tax.locality ?? "fairfax_county"))
                ?.reliefPercent === null && (
                <label className="block">
                  State relief on the first $20,000 (%, from your bill)
                  <input
                    type="number"
                    value={tax.vehicleRelief ?? 0}
                    onChange={(e) => setTax({ vehicleRelief: Number(e.target.value) })}
                    className={field}
                  />
                </label>
              )}
            </>
          )}
          {tax.type === "custom" && (
            <CustomTaxFields value={tax.custom} onChange={(custom) => setTax({ custom })} />
          )}
          {tax.type === "fica" && (
            <p className="text-xs text-slate-500">
              Social Security is 6.2% of pay up to $184,500 (2026); Medicare is 1.45%, plus 0.9%
              above $200,000. Health, dental, vision, FSA, and HSA payroll deductions marked as free
              of FICA are taken off first; 401(k) and TSP contributions are not.
            </p>
          )}
          {(tax.type === "state" || tax.type === "local" || tax.type === "vehicle") && (
            <label className="block">
              {tax.type === "vehicle"
                ? "My own rate per $100 (blank = county's)"
                : "My own flat rate % (blank = official)"}
              <input
                type="number"
                step="any"
                value={tax.customRate ?? ""}
                onChange={(e) =>
                  setTax({ customRate: e.target.value === "" ? null : Number(e.target.value) })
                }
                className={field}
              />
            </label>
          )}
          <p className="text-xs text-slate-500">
            Worked out from the income flowing in, after its pre-tax deductions. 2026 figures.
          </p>
        </>
      )}
      {(node.kind === "savings" || node.kind === "pretax") && (
        <label className="block">
          Growth per year %
          <input
            type="number"
            step="any"
            value={node.apy ?? 0}
            onChange={(e) => onChange({ apy: Number(e.target.value) })}
            className={field}
          />
        </label>
      )}
      {node.kind === "pretax" && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={node.ficaExempt ?? false}
            onChange={(e) => onChange({ ficaExempt: e.target.checked })}
          />
          <span>
            Also not taxed for Social Security &amp; Medicare (FICA)
            <span className="mt-0.5 block text-xs text-slate-500">
              Tick this for health, dental, or vision insurance, an FSA, or an HSA paid through your
              paycheck: those come out before every tax. Leave it unticked for a 401(k), 403(b), or
              TSP: those lower your income tax, but Social Security (6.2%) and Medicare (1.45%) are
              still taken from them.
            </span>
          </span>
        </label>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="text-xs text-red-700 hover:underline dark:text-red-400"
      >
        Remove this bucket
      </button>
    </div>
  );
}

function LinkEditor({
  graph,
  link,
  amount,
  money,
  onChange,
  onDelete,
}: {
  graph: FlowGraph;
  link: FlowLink;
  amount: number;
  money: (n: number) => string;
  onChange: (c: Partial<FlowLink>) => void;
  onDelete: () => void;
}) {
  const from = graph.nodes.find((n) => n.id === link.from);
  const to = graph.nodes.find((n) => n.id === link.to);
  const [per, setPer] = useState(12);
  const auto = isAutoLink(graph, link);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="font-semibold">
        {from?.label} → {to?.label}
      </h3>
      <div className="text-lg font-bold tabular-nums">{money(amount)}</div>
      {auto ? (
        <p className="text-xs text-slate-500">
          {to?.kind === "tax"
            ? "Worked out from the income, after its pre-tax deductions."
            : "The remainder of its source: what that bucket has not sent anywhere else. A bucket fed by several sources adds their remainders together."}
        </p>
      ) : (
        <div className="flex gap-2">
          <label className="block flex-1">
            Amount
            <input
              type="number"
              step="any"
              value={Math.round(((link.amount ?? 0) / per) * 100) / 100}
              onChange={(e) => onChange({ amount: Number(e.target.value) * per })}
              className={field}
            />
          </label>
          <label className="block">
            &nbsp;
            <Select value={per} onChange={(e) => setPer(Number(e.target.value))} className={field}>
              <option value={1}>per year</option>
              <option value={12}>per month</option>
              <option value={26}>every 2 weeks</option>
              <option value={52}>per week</option>
            </Select>
          </label>
        </div>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="text-xs text-red-700 hover:underline dark:text-red-400"
      >
        Remove this flow
      </button>
    </div>
  );
}

const MIN_W = CARD_W;
const MIN_H = CARD_H;

/**
 * One bucket on the map. Drag it to move it. Once it is selected, click its name to rename it. The
 * ✕ removes it; the grip in the bottom-left corner makes it wider or taller (never smaller than the
 * default); the colored dot on the right starts a new flow.
 */
function FlowCard({
  node,
  amount,
  overspent,
  selected,
  zoom,
  onSelect,
  onMove,
  onResize,
  onRename,
  onRemove,
  onConnectStart,
  track,
}: {
  node: FlowNode;
  amount: string;
  overspent: string | null;
  selected: boolean;
  zoom: number;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (change: { x: number; w: number; h: number }) => void;
  onRename: (label: string) => void;
  onRemove: () => void;
  onConnectStart: (e: React.PointerEvent) => void;
  track: (move: (e: PointerEvent) => void, up?: (e: PointerEvent) => void) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const pressedWhileSelected = useRef(false);
  const w = node.w ?? CARD_W;
  const h = node.h ?? CARD_H;
  const color = colorOf(node.kind);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <div
      data-flow-node={node.id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        onSelect();
        const s = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y };
        // Moves snap to the grid.
        track((m) =>
          onMove(snap(s.nx + (m.clientX - s.x) / zoom), snap(s.ny + (m.clientY - s.y) / zoom)),
        );
      }}
      className={`pointer-events-auto absolute flex cursor-move flex-col rounded-xl border-2 bg-white px-3 py-2.5 shadow-md dark:bg-slate-900 ${
        selected ? "ring-2 ring-amber-400" : ""
      }`}
      style={{ left: node.x, top: node.y, width: w, height: h, borderColor: color }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase" style={{ color }}>
          {KINDS.find((k) => k.kind === node.kind)!.label}
        </span>
        {selected && (
          <button
            type="button"
            aria-label={`Remove ${node.label}`}
            title="Remove this bucket"
            onPointerDown={stop}
            onClick={onRemove}
            className="-mt-1 -mr-1 rounded px-1 text-sm leading-none text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
          >
            ✕
          </button>
        )}
      </div>
      {renaming ? (
        <input
          aria-label="Bucket name"
          autoFocus
          defaultValue={node.label}
          onPointerDown={stop}
          onBlur={(e) => {
            onRename(e.target.value.trim() || node.label);
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenaming(false);
          }}
          className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1 text-sm font-semibold dark:border-slate-600 dark:bg-slate-800"
        />
      ) : (
        <div
          data-flow-name={node.id}
          title={selected ? "Click to rename" : node.label}
          onPointerDown={(e) => {
            // Once the bucket is selected, a click on its name renames it instead of dragging.
            // (The box opens on the click, after the mouse is released, so it keeps the focus.)
            pressedWhileSelected.current = selected && e.button === 0;
            if (pressedWhileSelected.current) e.stopPropagation();
          }}
          onClick={() => {
            if (pressedWhileSelected.current) setRenaming(true);
          }}
          className={`mt-0.5 truncate text-sm font-semibold ${selected ? "cursor-text rounded hover:bg-slate-100 dark:hover:bg-slate-800" : ""}`}
        >
          {node.label}
        </div>
      )}
      <div className="mt-1 text-lg font-bold tabular-nums">{amount}</div>
      {overspent && (
        <div className="mt-auto text-[11px] font-medium text-red-600">
          Sends {overspent} more than it has
        </div>
      )}
      {/* Resize from the bottom-left corner: left makes it wider, down makes it taller. */}
      {selected && (
        <span
          role="presentation"
          title="Drag to make wider or taller"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            onSelect();
            const s = { x: e.clientX, y: e.clientY };
            const start = { x: node.x, y: node.y, w, h };
            // Snapped to the grid, never smaller than the default.
            track((m) =>
              onResize(
                resizeFromBottomLeft(start, (m.clientX - s.x) / zoom, (m.clientY - s.y) / zoom, {
                  w: MIN_W,
                  h: MIN_H,
                }),
              ),
            );
          }}
          className="absolute bottom-0.5 left-0.5 h-4 w-4 cursor-nesw-resize text-slate-400"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
            <path d="M3 5 L3 13 L11 13" stroke="currentColor" strokeWidth="1.6" fill="none" />
            <path d="M3 9 L7 13" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </span>
      )}
      <span
        title="Drag onto another bucket to send money there"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          onConnectStart(e);
        }}
        className="absolute top-1/2 -right-2.5 h-5 w-5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-white shadow dark:border-slate-900"
        style={{ backgroundColor: color }}
      />
    </div>
  );
}

/** The fields of a custom tax: a percentage, a fixed amount, or brackets. */
function CustomTaxFields({
  value,
  onChange,
}: {
  value: CustomTax | undefined;
  onChange: (c: CustomTax) => void;
}) {
  const c: CustomTax = value ?? { mode: "percent", rate: 0, afterPretax: true };
  const set = (change: Partial<CustomTax>) => onChange({ ...c, ...change });
  const badBrackets =
    c.mode === "brackets" && (c.brackets ?? "").trim() !== "" && !parseBrackets(c.brackets ?? "");
  return (
    <>
      <label className="block">
        How it is charged
        <Select
          value={c.mode}
          onChange={(e) => set({ mode: e.target.value as CustomTax["mode"] })}
          className={field}
        >
          <option value="percent">A percentage of income</option>
          <option value="fixed">A fixed amount per year</option>
          <option value="brackets">Brackets (like income tax)</option>
        </Select>
      </label>
      {c.mode === "percent" && (
        <label className="block">
          Rate %
          <input
            type="number"
            step="any"
            value={c.rate ?? 0}
            onChange={(e) => set({ rate: Number(e.target.value) })}
            className={field}
          />
        </label>
      )}
      {c.mode === "fixed" && (
        <label className="block">
          Per year
          <input
            type="number"
            step="any"
            value={c.amount ?? 0}
            onChange={(e) => set({ amount: Number(e.target.value) })}
            className={field}
          />
        </label>
      )}
      {c.mode === "brackets" && (
        <label className="block">
          Brackets: from %, …
          <input
            value={c.brackets ?? ""}
            placeholder="0 2, 3000 3, 17000 5.75"
            onChange={(e) => set({ brackets: e.target.value })}
            className={field}
          />
          {badBrackets && (
            <span className="block text-xs text-red-600">
              Write “from percent” pairs, such as 0 2, 3000 3, 17000 5.75.
            </span>
          )}
        </label>
      )}
      {c.mode !== "fixed" && (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={c.afterPretax !== false}
            onChange={(e) => set({ afterPretax: e.target.checked })}
          />
          Take pre-tax deductions off the income first
        </label>
      )}
    </>
  );
}
