import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api } from "../api/client";
import { FlowMap } from "../components/sandbox/FlowMap";
import { SavedMaps } from "../components/sandbox/SavedMaps";
import { formatMinor } from "../lib/money";
import { lastOfMonth, monthOf, shiftMonth, today } from "../lib/period";
import { VIRGINIA_VEHICLE_LOCALITIES } from "../lib/sandbox/dmvTaxes";
import {
  evaluate,
  newId,
  newNode,
  NODE_DEFS,
  nodeDef,
  takeHomeTemplate,
  wouldLoop,
  type DataValues,
  type Graph,
  type NodeKind,
  type ParamDef,
  type SandboxNode,
  type ValueFormat,
} from "../lib/sandbox/graph";
import { Select } from "../components/common/Select";

/**
 * The sandbox: a playground of nodes. Add income, expenses, maths, and tax nodes from the left;
 * drag a node by its title; drag from a node's output (right) to another's input (left) to wire
 * them. Drag the background to move around, turn the mouse wheel to zoom. Everything is saved.
 */

interface View {
  x: number;
  y: number;
  zoom: number;
}
interface Saved extends Graph {
  view?: View;
}

const NODE_WIDTH = 230;
const GROUPS = ["Money", "Math", "Taxes", "Results"] as const;

const money = (n: number): string => formatMinor(Math.round(n * 100), "USD");
function show(value: number | undefined, format: ValueFormat = "money"): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return money(value);
}

/** Averages of real income and spending, per year, for the "From my data" node. */
function useDataValues(): DataValues {
  const [values, setValues] = useState<DataValues>({});
  useEffect(() => {
    const thisMonth = monthOf(today());
    const to = lastOfMonth(shiftMonth(thisMonth, -1));
    let cancelled = false;
    void Promise.all(
      [3, 6, 12].map(async (months) => {
        const from = `${shiftMonth(thisMonth, -months)}-01`;
        const s = await api<{ totals: { spendingMinor: number; incomeMinor: number } }>(
          `/analytics/summary?from=${from}&to=${to}&groupBy=none`,
        );
        const perYear = (minor: number) => (minor / 100 / months) * 12;
        return {
          [`spending:${months}`]: perYear(s.totals.spendingMinor),
          [`income:${months}`]: perYear(s.totals.incomeMinor),
        };
      }),
    )
      .then((parts) => !cancelled && setValues(Object.assign({}, ...parts)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return values;
}

function MathSandbox() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [view, setView] = useState<View>({ x: 30, y: 20, zoom: 0.72 });
  const [selected, setSelected] = useState<{ kind: "node" | "wire"; id: string } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const data = useDataValues();
  const canvas = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  // Load once; a first visit starts with the take-home pay example.
  useEffect(() => {
    void api<Saved | null>("/sandbox")
      .then((saved) => {
        setGraph(saved ? { nodes: saved.nodes, wires: saved.wires } : takeHomeTemplate());
        if (saved?.view) setView(saved.view);
      })
      .catch(() => setGraph(takeHomeTemplate()))
      .finally(() => {
        loaded.current = true;
      });
  }, []);

  // Save a moment after the last change.
  useEffect(() => {
    if (!graph || !loaded.current) return;
    setSaveState("saving");
    const timer = setTimeout(() => {
      api("/sandbox", { method: "PUT", body: JSON.stringify({ ...graph, view }) })
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [graph, view]);

  const result = useMemo(() => (graph ? evaluate(graph, data) : null), [graph, data]);

  const update = useCallback((change: (g: Graph) => Graph) => {
    setGraph((g) => (g ? change(g) : g));
  }, []);

  const addNode = (kind: NodeKind): void => {
    const box = canvas.current?.getBoundingClientRect();
    const cx = ((box?.width ?? 800) / 2 - view.x) / view.zoom - NODE_WIDTH / 2;
    const cy = ((box?.height ?? 600) / 2 - view.y) / view.zoom - 60;
    const id = newId("n");
    update((g) => ({
      ...g,
      nodes: [...g.nodes, newNode(kind, id, cx + Math.random() * 40, cy + Math.random() * 40)],
    }));
    setSelected({ kind: "node", id });
  };

  const removeSelected = useCallback((): void => {
    if (!selected) return;
    update((g) =>
      selected.kind === "wire"
        ? { ...g, wires: g.wires.filter((w) => w.id !== selected.id) }
        : {
            nodes: g.nodes.filter((n) => n.id !== selected.id),
            wires: g.wires.filter((w) => w.from.node !== selected.id && w.to.node !== selected.id),
          },
    );
    setSelected(null);
  }, [selected, update]);

  // Delete or Backspace removes what is selected (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      if (target.closest("input, select, textarea")) return;
      if (e.key === "Delete" || e.key === "Backspace") removeSelected();
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeSelected]);

  return (
    <section className="flex h-full min-h-[40rem] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sandbox</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Try out ideas: add nodes on the left, drag from an output (right side) to an input (left
            side) to wire them. Drag the background to move around, scroll to zoom, Delete removes
            what is selected. Money is yearly.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs text-slate-500" aria-live="polite">
            {saveState === "saving" ? "Saving..." : saveState === "error" ? "Not saved" : "Saved"}
          </span>
          {graph && (
            <SavedMaps
              kind="math"
              getData={() => ({ nodes: graph.nodes, wires: graph.wires, view })}
              onLoad={(data) => {
                const saved = data as unknown as Saved;
                setGraph({ nodes: saved.nodes ?? [], wires: saved.wires ?? [] });
                if (saved.view) setView(saved.view);
                setSelected(null);
              }}
            />
          )}
          <button
            type="button"
            onClick={() => setView({ x: 30, y: 20, zoom: 0.72 })}
            className="rounded border border-slate-300 px-3 py-1 dark:border-slate-600"
          >
            Reset view
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Replace everything with the take-home pay example?")) {
                setGraph(takeHomeTemplate());
                setSelected(null);
              }
            }}
            className="rounded border border-slate-300 px-3 py-1 dark:border-slate-600"
          >
            Take-home pay example
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Remove every node?")) {
                setGraph({ nodes: [], wires: [] });
                setSelected(null);
              }
            }}
            className="rounded border border-slate-300 px-3 py-1 text-red-700 dark:border-slate-600 dark:text-red-400"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <nav aria-label="Add a node" className="w-44 shrink-0 space-y-3 overflow-y-auto text-sm">
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="mb-1 text-xs font-semibold text-slate-500 uppercase">{group}</div>
              <div className="space-y-1">
                {(Object.keys(NODE_DEFS) as NodeKind[])
                  .filter((k) => nodeDef(k).group === group)
                  .map((k) => (
                    <button
                      key={k}
                      type="button"
                      title={nodeDef(k).description}
                      onClick={() => addNode(k)}
                      className="block w-full rounded border border-slate-200 px-2 py-1 text-left hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      + {nodeDef(k).label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </nav>

        {graph && result ? (
          <Canvas
            ref={canvas}
            graph={graph}
            view={view}
            setView={setView}
            update={update}
            evaluation={result}
            selected={selected}
            setSelected={setSelected}
          />
        ) : (
          <p className="text-sm text-slate-500">Loading...</p>
        )}
      </div>
    </section>
  );
}

interface CanvasProps {
  graph: Graph;
  view: View;
  setView: (v: View | ((v: View) => View)) => void;
  update: (change: (g: Graph) => Graph) => void;
  evaluation: ReturnType<typeof evaluate>;
  selected: { kind: "node" | "wire"; id: string } | null;
  setSelected: (s: { kind: "node" | "wire"; id: string } | null) => void;
  ref: React.Ref<HTMLDivElement>;
}

type PortKey = string; // `${node}:${in|out}:${port}`

function Canvas({
  graph,
  view,
  setView,
  update,
  evaluation,
  selected,
  setSelected,
  ref,
}: CanvasProps) {
  const inner = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement | null>(null);
  const [ports, setPorts] = useState<Record<PortKey, { x: number; y: number }>>({});
  const [pending, setPending] = useState<{
    node: string;
    port: string;
    x: number;
    y: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Where every port is, in canvas units, measured after each render (nodes differ in height).
  useLayoutEffect(() => {
    const root = inner.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const next: Record<PortKey, { x: number; y: number }> = {};
    root.querySelectorAll<HTMLElement>("[data-port]").forEach((el) => {
      const r = el.getBoundingClientRect();
      next[el.dataset["port"]!] = {
        x: (r.left + r.width / 2 - base.left) / view.zoom,
        y: (r.top + r.height / 2 - base.top) / view.zoom,
      };
    });
    const same =
      Object.keys(next).length === Object.keys(ports).length &&
      Object.entries(next).every(
        ([k, p]) =>
          ports[k] && Math.abs(ports[k].x - p.x) < 0.5 && Math.abs(ports[k].y - p.y) < 0.5,
      );
    if (!same) setPorts(next);
  });

  /** A point on the screen in canvas units. */
  const toCanvas = (clientX: number, clientY: number) => {
    const box = outer.current!.getBoundingClientRect();
    return {
      x: (clientX - box.left - view.x) / view.zoom,
      y: (clientY - box.top - view.y) / view.zoom,
    };
  };

  // Zoom around the mouse with the wheel (not passive, so the page does not scroll).
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
  }, [setView]);

  /** Follows the pointer until it is released. */
  const track = (onMove: (e: PointerEvent) => void, onUp?: (e: PointerEvent) => void): void => {
    const move = (e: PointerEvent): void => onMove(e);
    const up = (e: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onUp?.(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const panStart = (e: ReactPointerEvent): void => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    setSelected(null);
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    track((m) =>
      setView((v) => ({
        ...v,
        x: start.vx + m.clientX - start.x,
        y: start.vy + m.clientY - start.y,
      })),
    );
  };

  const dragNode = (e: ReactPointerEvent, node: SandboxNode): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected({ kind: "node", id: node.id });
    const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y };
    track((m) =>
      update((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === node.id
            ? {
                ...n,
                x: start.nx + (m.clientX - start.x) / view.zoom,
                y: start.ny + (m.clientY - start.y) / view.zoom,
              }
            : n,
        ),
      })),
    );
  };

  const wireStart = (e: ReactPointerEvent, node: string, port: string): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = toCanvas(e.clientX, e.clientY);
    setPending({ node, port, ...p });
    track(
      (m) => setPending((w) => (w ? { ...w, ...toCanvas(m.clientX, m.clientY) } : w)),
      (up) => {
        setPending(null);
        const target = document
          .elementFromPoint(up.clientX, up.clientY)
          ?.closest<HTMLElement>("[data-in]");
        if (!target) return;
        const [toNode, toPort] = target.dataset["in"]!.split(":") as [string, string];
        update((g) => {
          if (wouldLoop(g, node, toNode)) {
            setNotice("That wire would make a loop, so it was not added.");
            return g;
          }
          const exists = g.wires.some(
            (w) =>
              w.from.node === node &&
              w.from.port === port &&
              w.to.node === toNode &&
              w.to.port === toPort,
          );
          if (exists) return g;
          setNotice(null);
          return {
            ...g,
            wires: [
              ...g.wires,
              { id: newId("w"), from: { node, port }, to: { node: toNode, port: toPort } },
            ],
          };
        });
      },
    );
  };

  const curve = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  };

  return (
    <div
      ref={(el) => {
        outer.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
      }}
      onPointerDown={panStart}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-lg border border-slate-200 bg-slate-50 select-none dark:border-slate-700 dark:bg-slate-950"
      style={{
        backgroundImage: "radial-gradient(circle, rgb(148 163 184 / 0.35) 1px, transparent 1px)",
        backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
    >
      {notice && (
        <p
          role="status"
          className="absolute top-2 left-2 z-20 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900"
        >
          {notice}
        </p>
      )}
      {graph.nodes.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-500">
          Add a node from the list on the left, or load the take-home pay example.
        </p>
      )}
      <div
        ref={inner}
        className="pointer-events-none absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        <svg
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          width="1"
          height="1"
        >
          {graph.wires.map((w) => {
            const a = ports[`${w.from.node}:out:${w.from.port}`];
            const b = ports[`${w.to.node}:in:${w.to.port}`];
            if (!a || !b) return null;
            const isSelected = selected?.kind === "wire" && selected.id === w.id;
            return (
              <g key={w.id}>
                {/* A wide invisible line makes the wire easy to click. */}
                <path
                  d={curve(a, b)}
                  stroke="transparent"
                  strokeWidth={14}
                  fill="none"
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelected({ kind: "wire", id: w.id });
                  }}
                >
                  <title>Click to select, then press Delete to remove</title>
                </path>
                <path
                  d={curve(a, b)}
                  stroke={isSelected ? "#f59e0b" : "#3b82f6"}
                  strokeWidth={isSelected ? 3.5 : 2.5}
                  fill="none"
                />
              </g>
            );
          })}
          {pending && ports[`${pending.node}:out:${pending.port}`] && (
            <path
              d={curve(ports[`${pending.node}:out:${pending.port}`]!, pending)}
              stroke="#94a3b8"
              strokeWidth={2}
              strokeDasharray="6 4"
              fill="none"
            />
          )}
        </svg>
        {graph.nodes.map((n) => (
          <NodeBox
            key={n.id}
            node={n}
            outputs={evaluation.outputs[n.id]}
            inputs={evaluation.inputs[n.id]}
            error={evaluation.errors[n.id]}
            selected={selected?.kind === "node" && selected.id === n.id}
            onDrag={(e) => dragNode(e, n)}
            onWire={(e, port) => wireStart(e, n.id, port)}
            onChange={(change) =>
              update((g) => ({
                ...g,
                nodes: g.nodes.map((x) => (x.id === n.id ? { ...x, ...change } : x)),
              }))
            }
            onRemove={() =>
              update((g) => ({
                nodes: g.nodes.filter((x) => x.id !== n.id),
                wires: g.wires.filter((w) => w.from.node !== n.id && w.to.node !== n.id),
              }))
            }
          />
        ))}
      </div>
    </div>
  );
}

function NodeBox({
  node,
  outputs,
  inputs,
  error,
  selected,
  onDrag,
  onWire,
  onChange,
  onRemove,
}: {
  node: SandboxNode;
  outputs: Record<string, number> | undefined;
  inputs: Record<string, number> | undefined;
  error: string | undefined;
  selected: boolean;
  onDrag: (e: ReactPointerEvent) => void;
  onWire: (e: ReactPointerEvent, port: string) => void;
  onChange: (change: Partial<SandboxNode>) => void;
  onRemove: () => void;
}) {
  const def = nodeDef(node.kind);
  const [renaming, setRenaming] = useState(false);
  const accent = { Money: "#16a34a", Math: "#64748b", Taxes: "#dc2626", Results: "#2563eb" }[
    def.group
  ];
  return (
    <div
      className={`pointer-events-auto absolute rounded-lg border bg-white text-xs shadow-md dark:bg-slate-900 ${
        error
          ? "border-red-500"
          : selected
            ? "border-amber-500 ring-2 ring-amber-300"
            : "border-slate-300 dark:border-slate-600"
      }`}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        onPointerDown={onDrag}
        className="flex cursor-move items-center justify-between gap-1 rounded-t-lg px-2 py-1.5 text-white"
        style={{ backgroundColor: accent }}
        title={def.description}
      >
        {/* The title bar drags the node; double-click the name to rename it. */}
        {renaming ? (
          <input
            aria-label="Node name"
            autoFocus
            defaultValue={node.title ?? def.label}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              onChange({ title: e.target.value.trim() || undefined });
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="w-full min-w-0 rounded bg-white/20 px-1 font-semibold text-white outline-none"
          />
        ) : (
          <span
            data-node-title={node.id}
            onDoubleClick={() => setRenaming(true)}
            title={`${def.description} Double-click to rename.`}
            className="truncate font-semibold"
          >
            {node.title ?? def.label}
          </span>
        )}
        <button
          type="button"
          aria-label={`Remove ${node.title ?? def.label}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRemove}
          className="px-1 text-white/80 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="space-y-1.5 p-2">
        {def.params.map((p) => (
          <ParamField
            key={p.key}
            def={p}
            value={node.params[p.key]}
            onChange={(v) => onChange({ params: { ...node.params, [p.key]: v } })}
          />
        ))}

        {def.inputs.map((port) => (
          <div key={port.id} className="relative flex items-center justify-between pl-2">
            <span
              data-port={`${node.id}:in:${port.id}`}
              data-in={`${node.id}:${port.id}`}
              title={`Wire into ${port.label}`}
              className="absolute -left-[15px] h-3.5 w-3.5 rounded-full border-2 border-white bg-blue-500 shadow dark:border-slate-900"
            />
            <span className="text-slate-600 dark:text-slate-300">{port.label}</span>
            <span className="text-slate-400 tabular-nums">
              {inputs?.[port.id] !== undefined ? show(inputs[port.id]) : "—"}
            </span>
          </div>
        ))}

        {node.kind === "vehicle_tax" &&
          VIRGINIA_VEHICLE_LOCALITIES.find((l) => l.id === String(node.params["locality"])) && (
            <p className="text-[10px] leading-snug text-slate-500">
              Rate from:{" "}
              {
                VIRGINIA_VEHICLE_LOCALITIES.find((l) => l.id === String(node.params["locality"]))!
                  .source
              }
            </p>
          )}

        {node.kind === "result" && (
          <div className="rounded bg-blue-50 p-2 text-center dark:bg-blue-950">
            <div className="text-lg font-bold tabular-nums">{show(inputs?.["value"])}</div>
            <div className="text-slate-500">per year</div>
            <div className="mt-1 font-semibold tabular-nums">
              {inputs?.["value"] !== undefined ? show(inputs["value"] / 12) : "—"}
            </div>
            <div className="text-slate-500">per month</div>
          </div>
        )}

        {def.outputs.map((port) => (
          <div key={port.id} className="relative flex items-center justify-between pr-2">
            <span className="text-slate-600 dark:text-slate-300">{port.label}</span>
            <span className="font-semibold tabular-nums">
              {show(outputs?.[port.id], port.format)}
            </span>
            <span
              data-port={`${node.id}:out:${port.id}`}
              onPointerDown={(e) => onWire(e, port.id)}
              title={`Drag from ${port.label} to an input`}
              className="absolute -right-[15px] h-3.5 w-3.5 cursor-crosshair rounded-full border-2 border-white bg-emerald-500 shadow dark:border-slate-900"
            />
          </div>
        ))}

        {error && <p className="text-red-600">{error}</p>}
      </div>
    </div>
  );
}

function ParamField({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: string | number | boolean | undefined;
  onChange: (v: string | number) => void;
}) {
  const cls =
    "w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-800";
  return (
    <label className="block" onPointerDown={(e) => e.stopPropagation()}>
      <span className="text-[10px] text-slate-500">{def.label}</span>
      {def.type === "text" ? (
        <input
          type="text"
          value={String(value ?? def.default)}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          placeholder={def.key === "brackets" ? "0 2, 3000 3, 17000 5.75" : ""}
        />
      ) : def.type === "select" ? (
        <Select
          value={String(value ?? def.default)}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        >
          {def.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <span className="flex items-center gap-1">
          {def.type === "money" && <span className="text-slate-400">$</span>}
          <input
            type="number"
            step="any"
            value={String(value ?? def.default)}
            onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
            className={cls}
          />
          {def.type === "percent" && <span className="text-slate-400">%</span>}
        </span>
      )}
    </label>
  );
}

const MODE_KEY = "pf.sandbox.mode";

/** The sandbox: the maths nodes, or the experimental cash-flow map. */
export function SandboxPage() {
  const [mode, setMode] = useState<"math" | "flow">(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "flow" ? "flow" : "math";
    } catch {
      return "math";
    }
  });
  const choose = (m: "math" | "flow") => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Remembered for this visit only.
    }
  };
  return (
    <div className="flex h-full min-h-[40rem] flex-col gap-3">
      <div
        role="tablist"
        aria-label="Sandbox mode"
        className="flex gap-1 border-b border-slate-200 dark:border-slate-700"
      >
        {(
          [
            ["math", "Maths nodes"],
            ["flow", "Cash-flow map (experimental)"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => choose(value)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              mode === value
                ? "border-blue-600 font-medium text-blue-700 dark:text-blue-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "math" ? (
        <MathSandbox />
      ) : (
        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <div>
            <h1 className="text-2xl font-semibold">Cash-flow map</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Money flowing from your pay into taxes, pre-tax deductions, spending, and savings,
              with Maryland, DC, and Virginia taxes worked out for you.
            </p>
          </div>
          <FlowMap />
        </section>
      )}
    </div>
  );
}
