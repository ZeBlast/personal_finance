import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import {
  buildModel,
  DEFAULT_OPTIONS,
  LINK_COLORS,
  neighbours,
  type GraphData,
  type GraphLink,
  type GraphNode,
  type GraphTx,
  type ModelOptions,
} from "../../lib/graph/model";
import { DEFAULT_FORCES, Simulation, type Forces, type SimLink } from "../../lib/graph/sim";

/**
 * The network graph, after Obsidian's graph view: a dark canvas of small round nodes that settle
 * into place, labels that fade in as you zoom, and hovering a node lights up what it is connected
 * to. Institutions link to their accounts; accounts to their spending, grouped by category; income
 * comes in from outside; transfers link accounts. Zooming in on a group (or double-clicking it)
 * opens it into its transactions.
 */

const money = (minor: number) => formatMinor(minor, "USD");

/** Zoom at which groups on screen open into their transactions, and below which they close. */
const OPEN_AT = 1.9;
const CLOSE_AT = 1.4;
/** A group with more transactions than this only opens when asked (double-click). */
const AUTO_OPEN_MAX = 120;

function radiusOf(n: GraphNode): number {
  const dollars = n.weightMinor / 100;
  switch (n.kind) {
    case "institution":
      return 13;
    case "account":
      return Math.min(16, 8 + Math.sqrt(dollars) / 25);
    case "income":
    case "person":
      return Math.min(16, 6 + Math.sqrt(dollars) / 12);
    case "cluster":
      return Math.min(15, 4.5 + Math.sqrt(n.transactionIds.length) * 1.4);
    default:
      return Math.min(7, 2.5 + Math.sqrt(dollars) / 10);
  }
}

/** How hard each kind of node pushes others away: transactions gently, so opening a group does not blow the graph apart. */
const CHARGE: Record<GraphNode["kind"], number> = {
  institution: 1,
  account: 1,
  income: 0.8,
  person: 0.8,
  cluster: 0.5,
  transaction: 0.08,
};

function linkShape(l: GraphLink, target: GraphNode | undefined): SimLink {
  switch (l.kind) {
    case "owns":
      return { source: l.source, target: l.target, distance: 110, strength: 1 };
    case "income":
      return { source: l.source, target: l.target, distance: 190, strength: 0.25 };
    case "transfer":
      return { source: l.source, target: l.target, distance: 240, strength: 0.08 };
    case "external":
      return { source: l.source, target: l.target, distance: 170, strength: 0.25 };
    default:
      return target?.kind === "transaction"
        ? { source: l.source, target: l.target, distance: 34, strength: 0.9 }
        : { source: l.source, target: l.target, distance: 85, strength: 0.7 };
  }
}

/** Label visibility at a zoom level, 0 to 1, by kind (bigger things show their names sooner). */
function labelAlpha(kind: GraphNode["kind"], scale: number, textFade: number): number {
  const start = {
    institution: 0.25,
    account: 0.45,
    income: 0.7,
    person: 0.7,
    cluster: 0.9,
    transaction: 2.4,
  }[kind];
  const from = start * textFade;
  return Math.max(0, Math.min(1, (scale - from) / (from * 0.6 + 0.05)));
}

const prefersDark = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

export function NetworkGraph({ data }: { data: GraphData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sim = useRef(new Simulation());
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 0.8 });
  const hover = useRef<string | null>(null);
  const fade = useRef(0); // how far the hover highlight has faded in
  const frame = useRef(0);
  const dirty = useRef(true);
  /** Whether any transfer is drawn (they flow, so the canvas keeps redrawing). */
  const hasTransfers = useRef(false);
  /** Whether the view has been framed since the data arrived. */
  const framed = useRef(false);

  const [options, setOptions] = useState<Omit<ModelOptions, "openClusters">>({
    showIncome: DEFAULT_OPTIONS.showIncome,
    showTransfers: DEFAULT_OPTIONS.showTransfers,
    showExternal: DEFAULT_OPTIONS.showExternal,
    showSpending: DEFAULT_OPTIONS.showSpending,
    groupCategories: DEFAULT_OPTIONS.groupCategories,
    hideIdleAccounts: DEFAULT_OPTIONS.hideIdleAccounts,
    search: "",
  });
  const [forces, setForces] = useState<Forces>(DEFAULT_FORCES);
  const [textFade, setTextFade] = useState(1);
  /** Groups opened by hand (double-click) and by zooming in. */
  const [pinnedOpen, setPinnedOpen] = useState<ReadonlySet<string>>(new Set());
  const [zoomOpen, setZoomOpen] = useState<ReadonlySet<string>>(new Set());
  /** Groups closed by hand, which zooming does not open again. */
  const [keptShut, setKeptShut] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState(true);
  const [dark, setDark] = useState(prefersDark);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = () => {
      setDark(mq.matches);
      dirty.current = true;
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const openClusters = useMemo(() => new Set([...pinnedOpen, ...zoomOpen]), [pinnedOpen, zoomOpen]);
  const model = useMemo(
    () => buildModel(data, { ...options, openClusters }),
    [data, options, openClusters],
  );
  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model]);
  useEffect(() => {
    hasTransfers.current = model.links.some((l) => l.kind === "transfer" || l.kind === "external");
  }, [model]);
  const near = useMemo(() => neighbours(model), [model]);
  const txById = useMemo(() => new Map(data.transactions.map((t) => [t.id, t])), [data]);
  const navigate = useNavigate();
  /** Opens a transaction on the Transactions page, on whichever page of the list it is. */
  const openTransaction = useCallback(
    (id: number) => {
      const t = txById.get(id);
      const params = new URLSearchParams({ focus: String(id) });
      if (t) params.set("account", String(t.accountId));
      navigate(`/transactions?${params}`);
    },
    [navigate, txById],
  );
  const openRef = useRef(openTransaction);
  useEffect(() => {
    openRef.current = openTransaction;
  }, [openTransaction]);
  const accountName = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data]);

  // Hand the model to the simulation (nodes keep their places across changes).
  useEffect(() => {
    sim.current.setGraph(
      model.nodes.map((n) => ({ id: n.id, radius: radiusOf(n), charge: CHARGE[n.kind] })),
      model.links.map((l) => linkShape(l, nodeById.get(l.target))),
      // Opening or closing groups only nudges the layout.
      0.12,
    );
    dirty.current = true;
  }, [model, nodeById]);

  useEffect(() => {
    sim.current.forces = forces;
    sim.current.reheat(0.4);
  }, [forces]);

  // A new period: nodes in both keep their places (the layout carries over), the view is framed
  // again, and groups open or chosen in the old period are let go. Filters and forces stay.
  useEffect(() => {
    framed.current = false;
    sim.current.reheat(0.3);
    setPinnedOpen(new Set());
    setZoomOpen(new Set());
    setKeptShut(new Set());
    setSelected(null);
  }, [data]);

  /** Opens groups on screen once zoomed in far enough, and closes them on zooming out. */
  const updateZoomOpen = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { scale, x: cx, y: cy } = camera.current;
    if (scale < CLOSE_AT) {
      setZoomOpen((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    if (scale < OPEN_AT) return;
    const w = canvas.clientWidth / scale / 2;
    const h = canvas.clientHeight / scale / 2;
    const onScreen = model.nodes.filter((n) => {
      if (n.kind !== "cluster" || n.transactionIds.length > AUTO_OPEN_MAX || keptShut.has(n.id)) {
        return false;
      }
      const p = sim.current.nodes.get(n.id);
      return p !== undefined && Math.abs(p.x - cx) < w && Math.abs(p.y - cy) < h;
    });
    setZoomOpen((prev) => {
      const next = new Set(prev);
      for (const n of onScreen) next.add(n.id);
      return next.size === prev.size ? prev : next;
    });
  }, [model, keptShut]);

  // Drawing.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const { x: cx, y: cy, scale } = camera.current;
    const bg = dark ? "#1e1e1e" : "#ffffff";
    const text = dark ? "#dcddde" : "#2e3338";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(
      dpr * scale,
      0,
      0,
      dpr * scale,
      dpr * (w / 2 - cx * scale),
      dpr * (h / 2 - cy * scale),
    );

    const focus = hover.current ?? selected;
    const lit = focus ? new Set([focus, ...(near.get(focus) ?? [])]) : null;
    const f = fade.current;
    const dimmed = (id: string) => (lit && !lit.has(id) ? 1 - 0.85 * f : 1);

    // Links. Transfers going both ways between two accounts are drawn side by side.
    const transferKeys = new Set(
      model.links.filter((l) => l.kind === "transfer").map((l) => `${l.source}>${l.target}`),
    );
    const now = performance.now();
    for (const l of model.links) {
      const a = sim.current.nodes.get(l.source);
      const b = sim.current.nodes.get(l.target);
      if (!a || !b) continue;
      const on =
        lit !== null &&
        lit.has(l.source) &&
        lit.has(l.target) &&
        (l.source === focus || l.target === focus);
      const dollars = l.weightMinor / 100;
      const width =
        (l.kind === "income" || l.kind === "transfer" || l.kind === "external"
          ? 1 + Math.min(4, Math.log10(1 + dollars))
          : 1) / Math.sqrt(scale);
      ctx.globalAlpha = on
        ? 0.9
        : (l.kind === "owns" || l.kind === "spends" ? 0.35 : 0.6) *
          Math.min(dimmed(l.source), dimmed(l.target));
      ctx.strokeStyle =
        on && (l.kind === "owns" || l.kind === "spends") ? "#a78bfa" : LINK_COLORS[l.kind];
      ctx.lineWidth = on ? width * 1.6 : width;
      if (l.kind === "transfer" || l.kind === "external") {
        drawTransfer(
          ctx,
          l,
          a,
          b,
          ctx.lineWidth,
          scale,
          transferKeys.has(`${l.target}>${l.source}`),
          now,
        );
        continue;
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // Nodes.
    for (const n of model.nodes) {
      const p = sim.current.nodes.get(n.id);
      if (!p) continue;
      ctx.globalAlpha = dimmed(n.id);
      ctx.fillStyle = n.color;
      ctx.beginPath();
      if (n.kind === "income") {
        // Income sources are diamonds, outside the institutions' circles.
        const r = p.radius * 1.2;
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
      } else if (n.kind === "person") {
        // People money was sent to or received from are squares.
        const r = p.radius;
        ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      } else {
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      }
      ctx.fill();
      if (n.kind === "institution" || (n.kind === "cluster" && n.open) || n.id === focus) {
        ctx.lineWidth = 2 / scale;
        ctx.strokeStyle = n.id === focus ? "#a78bfa" : bg;
        ctx.stroke();
      }
    }

    // Labels, fading in with zoom (and always for what is lit).
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const n of model.nodes) {
      const p = sim.current.nodes.get(n.id);
      if (!p) continue;
      const isLit = lit?.has(n.id) ?? false;
      const alpha = isLit ? 1 : labelAlpha(n.kind, scale, textFade) * dimmed(n.id);
      if (alpha <= 0.02) continue;
      const size =
        (n.kind === "institution" ? 13 : n.kind === "transaction" ? 9 : 11) / Math.max(scale, 0.6);
      ctx.font = `${n.kind === "institution" ? 600 : 400} ${size}px system-ui, sans-serif`;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = text;
      const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
      ctx.fillText(label, p.x, p.y + p.radius + 3 / scale);
    }
    ctx.globalAlpha = 1;
  }, [dark, model, near, selected, textFade]);

  /** Frames every node in view (zoomed no closer than 1.2). */
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const list = [...sim.current.nodes.values()];
    if (!canvas || list.length === 0) return;
    const xs = list.map((n) => n.x);
    const ys = list.map((n) => n.y);
    const pad = 60;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    const scale = Math.min(
      1.2,
      canvas.clientWidth / Math.max(1, maxX - minX),
      canvas.clientHeight / Math.max(1, maxY - minY),
    );
    camera.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: Math.max(0.1, scale) };
    dirty.current = true;
  }, []);

  // The loop: steps the simulation while it moves, eases the hover highlight, and redraws.
  useEffect(() => {
    let last = 0;
    const loop = (t: number) => {
      const s = sim.current;
      const wantFade = hover.current || selected ? 1 : 0;
      const fading = Math.abs(fade.current - wantFade) > 0.01;
      if (fading) fade.current += (wantFade - fade.current) * 0.2;
      else fade.current = wantFade;
      if (s.running) {
        s.tick();
        dirty.current = true;
      }
      // Frame the graph once it has mostly settled, and keep framing it until then.
      if (!framed.current) {
        fit();
        if (s.alpha < 0.2) framed.current = true;
      }
      if (hasTransfers.current) dirty.current = true;
      if (dirty.current || fading) {
        draw();
        dirty.current = false;
      }
      if (t - last > 400) {
        last = t;
        updateZoomOpen();
      }
      frame.current = requestAnimationFrame(loop);
    };
    frame.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame.current);
  }, [draw, fit, selected, updateZoomOpen]);

  // Pointer: pan, zoom, drag nodes, hover, click, double-click.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const toWorld = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      const { x, y, scale } = camera.current;
      return {
        x: (e.clientX - r.left - r.width / 2) / scale + x,
        y: (e.clientY - r.top - r.height / 2) / scale + y,
      };
    };
    let drag: { kind: "node"; id: string } | { kind: "pan"; x: number; y: number } | null = null;
    let moved = false;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const w = toWorld(e);
      const n = sim.current.nodeAt(w.x, w.y, 4 / camera.current.scale);
      moved = false;
      canvas.setPointerCapture(e.pointerId);
      if (n) {
        drag = { kind: "node", id: n.id };
        n.fixed = true;
      } else {
        drag = { kind: "pan", x: e.clientX, y: e.clientY };
      }
    };
    const move = (e: PointerEvent) => {
      const w = toWorld(e);
      if (drag?.kind === "node") {
        const n = sim.current.nodes.get(drag.id);
        if (n) {
          n.x = w.x;
          n.y = w.y;
          moved = true;
          sim.current.reheat(0.3);
        }
      } else if (drag?.kind === "pan") {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        camera.current.x -= dx / camera.current.scale;
        camera.current.y -= dy / camera.current.scale;
        drag = { kind: "pan", x: e.clientX, y: e.clientY };
      } else {
        const n = sim.current.nodeAt(w.x, w.y, 4 / camera.current.scale);
        const id = n?.id ?? null;
        if (id !== hover.current) {
          hover.current = id;
          canvas.style.cursor = id ? "pointer" : "grab";
        }
      }
      dirty.current = true;
    };
    const up = (e: PointerEvent) => {
      if (drag?.kind === "node") {
        const n = sim.current.nodes.get(drag.id);
        if (n) n.fixed = false;
        if (!moved) {
          // A transaction opens on the Transactions page; anything else shows its details here.
          if (drag.id.startsWith("tx:")) openRef.current(Number(drag.id.slice(3)));
          else setSelected(drag.id);
        }
      } else if (drag?.kind === "pan" && !moved) {
        setSelected(null);
      }
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    const leave = () => {
      if (!drag) hover.current = null;
      dirty.current = true;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const before = toWorld(e);
      const c = camera.current;
      c.scale = Math.min(8, Math.max(0.1, c.scale * Math.exp(-e.deltaY * 0.0015)));
      const after = toWorld(e);
      // Zoom around the pointer.
      c.x += before.x - after.x;
      c.y += before.y - after.y;
      dirty.current = true;
    };
    const dbl = (e: MouseEvent) => {
      const w = toWorld(e);
      const n = sim.current.nodeAt(w.x, w.y, 4 / camera.current.scale);
      if (!n || !n.id.startsWith("cl:")) return;
      toggleRef.current(n.id);
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("dblclick", dbl);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("dblclick", dbl);
    };
  }, []);

  // Redraw when the box changes size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      dirty.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggleOpen = useCallback(
    (id: string) => {
      const isOpen = openClusters.has(id);
      const without = (prev: ReadonlySet<string>) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      };
      const withIt = (prev: ReadonlySet<string>) => new Set([...prev, id]);
      if (isOpen) {
        setPinnedOpen(without);
        setZoomOpen(without);
        setKeptShut(withIt);
      } else {
        setPinnedOpen(withIt);
        setKeptShut(without);
      }
    },
    [openClusters],
  );
  const toggleRef = useRef(toggleOpen);
  toggleRef.current = toggleOpen;

  const selectedNode = selected ? nodeById.get(selected) : undefined;
  const counts = {
    nodes: model.nodes.length,
    transactions: model.nodes.filter((n) => n.kind === "transaction").length,
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-[calc(100vh-11rem)] min-h-[28rem] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700"
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Network of ${data.institutions.length} institutions, ${data.accounts.length} accounts, and ${data.transactions.length} transactions`}
        className="block h-full w-full cursor-grab touch-none"
      />

      {/* Settings, like Obsidian's graph panel. */}
      <div className="absolute top-3 right-3 w-64 text-sm">
        <button
          type="button"
          onClick={() => setPanel((v) => !v)}
          aria-expanded={panel}
          className="ml-auto block rounded-md bg-white/90 px-2 py-1 text-xs shadow ring-1 ring-slate-200 dark:bg-slate-800/90 dark:ring-slate-600"
        >
          {panel ? "Hide settings" : "Settings"}
        </button>
        {panel && (
          <div className="mt-2 max-h-[calc(100vh-16rem)] space-y-3 overflow-y-auto rounded-lg bg-white/95 p-3 shadow-lg ring-1 ring-slate-200 dark:bg-slate-800/95 dark:ring-slate-600">
            <Group title="Filters">
              <input
                type="search"
                value={options.search}
                placeholder="Search merchants, categories..."
                aria-label="Search the graph"
                onChange={(e) => setOptions((o) => ({ ...o, search: e.target.value }))}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
              />
              <Toggle
                label="Income"
                checked={options.showIncome}
                onChange={(v) => setOptions((o) => ({ ...o, showIncome: v }))}
              />
              <Toggle
                label="Spending (groups and transactions)"
                checked={options.showSpending}
                onChange={(v) => setOptions((o) => ({ ...o, showSpending: v }))}
              />
              <Toggle
                label="Group categories across accounts"
                checked={options.groupCategories}
                onChange={(v) => setOptions((o) => ({ ...o, groupCategories: v }))}
              />
              <Toggle
                label="Transfers between accounts"
                checked={options.showTransfers}
                onChange={(v) => setOptions((o) => ({ ...o, showTransfers: v }))}
              />
              <Toggle
                label="Transfers to and from people"
                checked={options.showExternal}
                onChange={(v) => setOptions((o) => ({ ...o, showExternal: v }))}
              />
              <Toggle
                label="Accounts with no activity"
                checked={!options.hideIdleAccounts}
                onChange={(v) => setOptions((o) => ({ ...o, hideIdleAccounts: !v }))}
              />
            </Group>
            <Group title="Display">
              <Slider
                label="Text fade"
                min={0.3}
                max={2}
                step={0.05}
                value={textFade}
                onChange={(v) => {
                  setTextFade(v);
                  dirty.current = true;
                }}
              />
              <button
                type="button"
                className="w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
                onClick={fit}
              >
                Fit to screen
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
                  onClick={() => {
                    setPinnedOpen(
                      new Set(model.nodes.filter((n) => n.kind === "cluster").map((n) => n.id)),
                    );
                    setKeptShut(new Set());
                  }}
                >
                  Open all groups
                </button>
                <button
                  type="button"
                  className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
                  onClick={() => {
                    setPinnedOpen(new Set());
                    setZoomOpen(new Set());
                    setKeptShut(
                      new Set(model.nodes.filter((n) => n.kind === "cluster").map((n) => n.id)),
                    );
                  }}
                >
                  Close all
                </button>
              </div>
            </Group>
            <Group title="Forces">
              <Slider
                label="Center force"
                min={0}
                max={2}
                step={0.05}
                value={forces.center}
                onChange={(v) => setForces((f) => ({ ...f, center: v }))}
              />
              <Slider
                label="Repel force"
                min={0.1}
                max={4}
                step={0.1}
                value={forces.repel}
                onChange={(v) => setForces((f) => ({ ...f, repel: v }))}
              />
              <Slider
                label="Link force"
                min={0.1}
                max={2}
                step={0.05}
                value={forces.link}
                onChange={(v) => setForces((f) => ({ ...f, link: v }))}
              />
              <Slider
                label="Link distance"
                min={0.3}
                max={3}
                step={0.05}
                value={forces.linkDistance}
                onChange={(v) => setForces((f) => ({ ...f, linkDistance: v }))}
              />
            </Group>
            <p className="text-xs text-slate-500">
              {counts.nodes} nodes · {counts.transactions} transactions shown. Scroll to zoom; zoom
              in on a group (or double-click it) to see its transactions, and click one to open it
              on the Transactions page.
            </p>
          </div>
        )}
      </div>

      {/* What a node is, with its transactions. */}
      {selectedNode && (
        <Details
          node={selectedNode}
          txs={selectedNode.transactionIds
            .map((id) => txById.get(id))
            .filter((t): t is GraphTx => t !== undefined)}
          accountName={accountName}
          open={openClusters.has(selectedNode.id)}
          onToggleOpen={() => toggleOpen(selectedNode.id)}
          onClose={() => setSelected(null)}
          onOpen={openTransaction}
        />
      )}

      <Legend />
    </div>
  );
}

/**
 * One direction of transfers between two accounts: a dashed line whose dashes flow from the
 * account the money left toward the one it went to, ending in an arrowhead. When money also went
 * the other way, each direction keeps to its own side so the two lines sit next to each other.
 */
function drawTransfer(
  ctx: CanvasRenderingContext2D,
  l: GraphLink,
  a: { x: number; y: number; radius: number },
  b: { x: number; y: number; radius: number },
  width: number,
  scale: number,
  bothWays: boolean,
  now: number,
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return;
  const ux = dx / length;
  const uy = dy / length;
  // To the right of the direction of travel; the other direction's right is the opposite side.
  const side = bothWays ? 4 / scale + width / 2 : 0;
  const nx = -uy * side;
  const ny = ux * side;
  const head = Math.max(7 / scale, width * 3);
  const startX = a.x + ux * a.radius + nx;
  const startY = a.y + uy * a.radius + ny;
  const tipX = b.x - ux * (b.radius + 2 / scale) + nx;
  const tipY = b.y - uy * (b.radius + 2 / scale) + ny;
  ctx.strokeStyle = LINK_COLORS[l.kind];
  ctx.fillStyle = LINK_COLORS[l.kind];
  ctx.setLineDash([6 / scale, 4 / scale]);
  // The dashes move toward the receiving account.
  ctx.lineDashOffset = -((now / 40) % 10) / scale;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(tipX - ux * head * 0.8, tipY - uy * head * 0.8);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * head - uy * head * 0.5, tipY - uy * head + ux * head * 0.5);
  ctx.lineTo(tipX - ux * head + uy * head * 0.5, tipY - uy * head - ux * head * 0.5);
  ctx.closePath();
  ctx.fill();
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="block w-full"
      />
    </label>
  );
}

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  institution: "Institution",
  account: "Account",
  income: "Income source",
  person: "Person (money sent or received)",
  cluster: "Spending group",
  transaction: "Transaction",
};

function Details({
  node,
  txs,
  accountName,
  open,
  onToggleOpen,
  onClose,
  onOpen,
}: {
  node: GraphNode;
  txs: GraphTx[];
  accountName: Map<number, string>;
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  /** Opens a transaction on the Transactions page. */
  onOpen: (id: number) => void;
}) {
  const sorted = [...txs].sort((a, b) => b.date.localeCompare(a.date));
  const single = node.kind === "transaction" ? sorted[0] : undefined;
  return (
    <div className="absolute bottom-3 left-3 max-h-[60%] w-80 overflow-y-auto rounded-lg bg-white/95 p-3 text-sm shadow-lg ring-1 ring-slate-200 dark:bg-slate-800/95 dark:ring-slate-600">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs text-slate-500">{KIND_LABEL[node.kind]}</div>
          <div className="font-semibold">{node.label}</div>
        </div>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          ✕
        </button>
      </div>
      {single ? (
        <dl className="mt-2 space-y-1">
          <Row label="Date" value={formatDay(single.date)} />
          <Row
            label="Amount"
            value={`${single.amountMinor < 0 ? "+" : "−"}${money(Math.abs(single.amountMinor))}`}
          />
          <Row label="Account" value={accountName.get(single.accountId) ?? ""} />
          <Row
            label="Category"
            value={
              single.subcategoryName
                ? `${single.categoryName ?? ""} › ${single.subcategoryName}`
                : (single.categoryName ?? "Uncategorized")
            }
          />
          {single.pending && <Row label="Status" value="Pending" />}
        </dl>
      ) : (
        <>
          {node.kind === "account" && <Row label="Balance" value={money(node.weightMinor)} />}
          {txs.length > 0 && (
            <p className="mt-1 text-slate-600 dark:text-slate-300">
              {txs.length} transaction{txs.length === 1 ? "" : "s"} ·{" "}
              {node.kind === "income"
                ? "received "
                : node.kind === "person"
                  ? "sent or received "
                  : ""}
              {money(Math.abs(node.weightMinor))}
            </p>
          )}
          {node.kind === "cluster" && (
            <button
              type="button"
              onClick={onToggleOpen}
              className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
            >
              {open ? "Group them again" : "Show each transaction"}
            </button>
          )}
          {sorted.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-700">
              {sorted.slice(0, 40).map((t) => (
                <li key={t.id} className="flex justify-between gap-2 py-1">
                  <button
                    type="button"
                    onClick={() => onOpen(t.id)}
                    title="Open on the Transactions page"
                    className="min-w-0 truncate text-left hover:underline"
                  >
                    <span className="text-slate-500">{formatDay(t.date)}</span> {t.merchant}
                  </button>
                  <span
                    className={`shrink-0 tabular-nums ${t.amountMinor < 0 ? "text-green-700 dark:text-green-400" : ""}`}
                  >
                    {t.amountMinor < 0 ? "+" : "−"}
                    {money(Math.abs(t.amountMinor))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {sorted.length > 40 && (
            <p className="mt-1 text-xs text-slate-500">and {sorted.length - 40} more</p>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function Legend() {
  const item = (shape: ReactNode, label: string) => (
    <li className="flex items-center gap-1.5">
      {shape}
      {label}
    </li>
  );
  const dot = (color: string, size = 10) => (
    <span
      aria-hidden="true"
      className="inline-block rounded-full"
      style={{ backgroundColor: color, width: size, height: size }}
    />
  );
  return (
    <ul className="absolute top-3 left-3 space-y-1 rounded-md bg-white/80 px-2 py-1.5 text-xs shadow-sm ring-1 ring-slate-200 dark:bg-slate-800/80 dark:ring-slate-600">
      {item(dot("#a78bfa", 12), "Institution")}
      {item(dot("#2563eb"), "Account")}
      {item(
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rotate-45 bg-green-500" />,
        "Income",
      )}
      {item(dot("#f59e0b", 8), "Spending group / transaction")}
      {item(
        <span
          aria-hidden="true"
          className="inline-block w-4 border-t-2 border-dashed border-sky-400"
        />,
        "Transfer",
      )}
      {item(
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 bg-orange-500" />,
        "Person (money sent or received)",
      )}
    </ul>
  );
}
