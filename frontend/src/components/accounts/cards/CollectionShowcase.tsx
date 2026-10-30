import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { useApi } from "../../../hooks/useApi";
import { formatMinor } from "../../../lib/money";
import type { Account } from "../../../types/api";
import { Modal } from "../../common/Modal";
import { Select } from "../../common/Select";

interface Item {
  id: number;
  name: string;
  variant: string;
  setCode: string;
  number: string;
  quantity: number;
  unitValueMinor: number | null;
  totalValueMinor: number;
  condition: string | null;
  notes: string | null;
  tcgplayerId: string | null;
  marketPriceMinor: number | null;
  priceUpdatedAt: string | null;
}

interface Collection {
  accountId: number;
  name: string;
  type: "pokemon" | "other";
  items: Item[];
  totalValueMinor: number;
}

type Sort = "value" | "name";

const money = (minor: number | null) => formatMinor(minor, "USD");

/**
 * TCGplayer's public pictures of a card, when the item is matched to a TCGplayer product. The
 * sizes its image server has: `200w`, `400w`, and `in_1000x1000` (the largest, about 720 by 1000
 * for a card); anything else is refused.
 */
type ImageSize = "200w" | "400w" | "in_1000x1000";
const cardImage = (id: string, size: ImageSize = "200w") =>
  `https://tcgplayer-cdn.tcgplayer.com/product/${id}_${size}.jpg`;
/** For the close-up: the largest first, smaller ones if it can't be had. */
const CLOSE_UP_SIZES: ImageSize[] = ["in_1000x1000", "400w", "200w"];

/** The preview's narrowest item, in pixels (the grid's minimum column), and the gap between. */
const PREVIEW_MIN = { pokemon: 104, other: 144 };
const PREVIEW_GAP = 12;

/**
 * A collection shown for what it is: a preview of its most valuable items (Pokémon cards as cards,
 * with their pictures; anything else as boxes on a shelf), and "View all" for a large window to
 * scroll, search and sort through every item. Click an item for a closer look you can zoom into
 * and drag around. "Manage" opens the full collection editor.
 */
export function CollectionShowcase({
  account,
  onManage,
  onDelete,
}: {
  account: Account;
  onManage: () => void;
  /** Deletes the whole collection account (after asking); the dashboard widget leaves it out. */
  onDelete?: () => void;
}) {
  const loaded = useApi<Collection>(`/accounts/${account.id}/collection`);
  const [browsing, setBrowsing] = useState(false);
  const [open, setOpen] = useState<Item | null>(null);
  const c = loaded.data;
  const pokemon = c?.type === "pokemon";
  const byValue = useMemo(
    () =>
      [...(c?.items ?? [])].sort(
        (a, b) => b.totalValueMinor - a.totalValueMinor || a.name.localeCompare(b.name),
      ),
    [c],
  );
  const pieces = byValue.reduce((n, i) => n + i.quantity, 0);
  // The preview is one full row across the box: as many items as fit its width.
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const hasItems = byValue.length > 0;
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasItems]);
  const min = pokemon ? PREVIEW_MIN.pokemon : PREVIEW_MIN.other;
  const preview = Math.max(1, Math.floor((width + PREVIEW_GAP) / (min + PREVIEW_GAP)));

  return (
    <div className="relative overflow-hidden rounded-md border border-slate-200 bg-white p-4 pl-5 dark:border-slate-700 dark:bg-slate-900">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1.5"
        style={{ backgroundColor: account.color ?? "#94a3b8" }}
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">{account.name}</div>
          <div className="text-xs text-slate-500">
            {c
              ? `${pieces} item${pieces === 1 ? "" : "s"} · worth ${money(c.totalValueMinor)}${pokemon ? " · Pokémon cards" : ""}`
              : "Loading..."}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {c && c.items.length > 0 && (
            <button
              type="button"
              onClick={() => setBrowsing(true)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              View all {c.items.length}
            </button>
          )}
          <button
            type="button"
            onClick={onManage}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
          >
            Manage
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete the collection ${account.name}`}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {loaded.error && <p className="text-sm text-red-600">{loaded.error}</p>}
      {c && byValue.length === 0 && (
        <p className="text-sm text-slate-500">Nothing in it yet. Use Manage to add items.</p>
      )}
      {byValue.length > 0 && (
        <div className="relative" ref={row}>
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${preview}, minmax(0, 1fr))` }}
          >
            {byValue
              .slice(0, preview)
              .map((item) =>
                pokemon ? (
                  <PokemonCard key={item.id} item={item} onOpen={() => setOpen(item)} />
                ) : (
                  <ShelfItem key={item.id} item={item} onOpen={() => setOpen(item)} />
                ),
              )}
          </div>
          {byValue.length > preview && (
            <button
              type="button"
              onClick={() => setBrowsing(true)}
              className="mt-3 w-full rounded-md border border-dashed border-slate-300 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              and {byValue.length - preview} more · view all
            </button>
          )}
        </div>
      )}
      {browsing && c && (
        <Browser collection={c} onOpen={setOpen} onClose={() => setBrowsing(false)} />
      )}
      {open && <Viewer item={open} pokemon={pokemon} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Every item, in a large window that scrolls, with search and sort. */
function Browser({
  collection: c,
  onOpen,
  onClose,
}: {
  collection: Collection;
  onOpen: (item: Item) => void;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<Sort>("value");
  const [query, setQuery] = useState("");
  const pokemon = c.type === "pokemon";
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = c.items.filter(
      (i) =>
        !q ||
        i.name.toLowerCase().includes(q) ||
        `${i.setCode} ${i.number} ${i.variant}`.toLowerCase().includes(q),
    );
    return sort === "value"
      ? list.sort((a, b) => b.totalValueMinor - a.totalValueMinor || a.name.localeCompare(b.name))
      : list.sort((a, b) => a.name.localeCompare(b.name));
  }, [c, sort, query]);

  return (
    <Modal
      title={`${c.name} · ${money(c.totalValueMinor)}`}
      onClose={onClose}
      wide="full"
      dismissible
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, set or number"
          aria-label="Search the collection"
          className="min-w-48 flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900"
        />
        <Select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900"
        >
          <option value="value">Most valuable first</option>
          <option value="name">By name</option>
        </Select>
        <span className="text-xs text-slate-500">
          {items.length} of {c.items.length}
        </span>
      </div>
      <div
        className={`grid max-h-[70vh] gap-4 overflow-y-auto rounded-lg p-3 ${
          pokemon
            ? "bg-gradient-to-br from-slate-800 to-slate-900"
            : "bg-slate-50 dark:bg-slate-900"
        }`}
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${pokemon ? "9rem" : "11rem"}, 1fr))`,
        }}
      >
        {items.map((item) =>
          pokemon ? (
            <PokemonCard key={item.id} item={item} large onOpen={() => onOpen(item)} />
          ) : (
            <ShelfItem key={item.id} item={item} large onOpen={() => onOpen(item)} />
          ),
        )}
        {items.length === 0 && <p className="text-sm text-slate-500">Nothing matches.</p>}
      </div>
    </Modal>
  );
}

/** A Pokémon card that tilts and shines under the mouse. */
function PokemonCard({ item, onOpen, large }: { item: Item; onOpen: () => void; large?: boolean }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [broken, setBroken] = useState(false);
  const picture =
    item.tcgplayerId && !broken ? cardImage(item.tcgplayerId, large ? "400w" : "200w") : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${item.name} · ${money(item.totalValueMinor)}`}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTilt({
          x: (e.clientX - r.left) / r.width - 0.5,
          y: (e.clientY - r.top) / r.height - 0.5,
        });
      }}
      onMouseLeave={() => setTilt({ x: 0, y: 0 })}
      className="group relative aspect-[63/88] w-full [perspective:600px] focus-visible:outline-none"
    >
      <span
        className="absolute inset-0 overflow-hidden rounded-lg bg-slate-700 shadow-md ring-1 ring-black/40 transition-transform duration-200 ease-out group-hover:-translate-y-1 group-hover:shadow-xl group-focus-visible:ring-4 group-focus-visible:ring-amber-300"
        style={{ transform: `rotateY(${tilt.x * 18}deg) rotateX(${-tilt.y * 18}deg)` }}
      >
        {picture ? (
          <img
            src={picture}
            alt={item.name}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-amber-300 via-yellow-200 to-amber-500 p-1.5 text-left text-slate-900">
            <span className="line-clamp-3 text-[0.7rem] leading-tight font-bold">{item.name}</span>
            <span className="text-[0.6rem] opacity-70">
              {item.setCode} {item.number}
            </span>
          </span>
        )}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-0 mix-blend-overlay transition-opacity group-hover:opacity-100"
          style={{
            background: `linear-gradient(${105 + tilt.x * 60}deg, transparent 30%, rgba(255,255,255,0.55) 50%, transparent 70%)`,
          }}
        />
        {item.quantity > 1 && (
          <span className="absolute top-1 right-1 rounded-full bg-black/70 px-1.5 text-[0.6rem] font-semibold text-white">
            ×{item.quantity}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 bg-black/65 px-1 py-0.5 text-center text-[0.65rem] font-medium text-white tabular-nums">
          {money(item.totalValueMinor)}
        </span>
      </span>
    </button>
  );
}

const hue = (name: string) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);

/** Anything else: a box on a shelf that lifts under the mouse. */
function ShelfItem({ item, onOpen, large }: { item: Item; onOpen: () => void; large?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${item.name} · ${money(item.totalValueMinor)}`}
      style={{ background: `hsl(${hue(item.name)} 50% 42%)` }}
      className={`flex flex-col justify-between rounded-lg border-b-4 border-black/25 p-2.5 text-left text-white shadow-md transition hover:-translate-y-1.5 hover:shadow-xl focus-visible:ring-4 focus-visible:ring-blue-400 focus-visible:outline-none ${
        large ? "h-36" : "h-24"
      }`}
    >
      <span className="line-clamp-3 text-sm leading-tight font-semibold">{item.name}</span>
      <span className="text-xs tabular-nums opacity-90">
        {money(item.totalValueMinor)}
        {item.quantity > 1 ? ` · ×${item.quantity}` : ""}
      </span>
    </button>
  );
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

/**
 * One item, up close, over everything else: the picture (or the item's box) zooms with the mouse
 * wheel or the buttons, and drags around when zoomed in; double-click puts it back. Its details
 * sit beside it. Escape or a click outside closes it.
 */
function Viewer({ item, pokemon, onClose }: { item: Item; pokemon: boolean; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  /** Which of CLOSE_UP_SIZES is being tried; past the end, none could be had. */
  const [attempt, setAttempt] = useState(0);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  /** The picture (or the item's box), as zoomed and moved. */
  const picturePart = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; onPicture: boolean; onControl: boolean } | null>(
    null,
  );
  const size = CLOSE_UP_SIZES[attempt];
  const picture = pokemon && item.tcgplayerId && size ? cardImage(item.tcgplayerId, size) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(MAX_ZOOM, z * 1.25));
      else if (e.key === "-") setZoom((z) => Math.max(MIN_ZOOM, z / 1.25));
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Zoomed all the way out, there is nothing to pan.
  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  function reset(): void {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  /** Zooms toward the point under the mouse, so that point stays put. */
  function onWheel(e: WheelEvent<HTMLDivElement>): void {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const cx = e.clientX - box.left - box.width / 2;
    const cy = e.clientY - box.top - box.height / 2;
    const k = next / zoom;
    setPan((p) => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
    setZoom(next);
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Where the press began: a click that starts and ends off the picture closes the viewer.
    press.current = {
      x: e.clientX,
      y: e.clientY,
      onPicture: picturePart.current?.contains(target) ?? false,
      onControl: target.closest("button") !== null,
    };
    // A press on the zoom buttons is theirs: capturing it here would swallow their click.
    if (zoom === 1 || press.current.onControl) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };
  /** A click off the picture (not a drag, not on a button) closes the viewer. */
  const onStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.onPicture || p.onControl) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
    onClose();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.panX + e.clientX - drag.current.x,
      y: drag.current.panY + e.clientY - drag.current.y,
    });
  };
  const endDrag = () => {
    drag.current = null;
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      className="fixed inset-0 z-[60] flex flex-col bg-black/85 text-white lg:flex-row"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={stage}
        className={`relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden select-none ${
          zoom > 1 ? (drag.current ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onStageClick}
      >
        <div
          ref={picturePart}
          onDoubleClick={() => (zoom > 1 ? reset() : setZoom(2.5))}
          className={`transition-transform duration-75 ease-out will-change-transform ${zoom === 1 ? "cursor-zoom-in" : ""}`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {picture ? (
            <img
              key={picture}
              src={picture}
              alt={item.name}
              draggable={false}
              onError={() => setAttempt((a) => a + 1)}
              className="max-h-[80vh] max-w-[80vw] rounded-2xl shadow-2xl lg:max-w-[55vw]"
            />
          ) : (
            <div
              style={{ background: `hsl(${hue(item.name)} 50% 42%)` }}
              className="flex h-[22rem] w-64 flex-col justify-between rounded-2xl border-b-8 border-black/25 p-5 shadow-2xl"
            >
              <span className="text-2xl leading-tight font-bold">{item.name}</span>
              <span className="text-lg tabular-nums">{money(item.totalValueMinor)}</span>
            </div>
          )}
        </div>
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-sm">
          <ZoomButton label="Zoom out" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))}>
            −
          </ZoomButton>
          <span className="w-14 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <ZoomButton label="Zoom in" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}>
            +
          </ZoomButton>
          <ZoomButton label="Fit" onClick={reset}>
            ⤢
          </ZoomButton>
        </div>
        <p className="absolute top-4 left-4 text-xs text-white/60">
          Scroll to zoom · drag to move · double-click to reset · click outside or Esc to close
        </p>
      </div>

      <aside className="w-full shrink-0 overflow-y-auto bg-slate-900/90 p-5 text-sm lg:w-80">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{item.name}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded px-2 text-white/70 hover:text-white"
          >
            ✕
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {item.variant && <Detail label="Variant" value={item.variant} />}
          {(item.setCode || item.number) && (
            <Detail label="Set" value={`${item.setCode} ${item.number}`.trim()} />
          )}
          {item.condition && <Detail label="Condition" value={item.condition} />}
          <Detail label="Quantity" value={String(item.quantity)} />
          <Detail label="Each" value={money(item.unitValueMinor)} />
          <Detail label="Together" value={money(item.totalValueMinor)} />
          {item.marketPriceMinor !== null && (
            <Detail label="Market price" value={money(item.marketPriceMinor)} />
          )}
          {item.notes && <Detail label="Notes" value={item.notes} />}
        </dl>
      </aside>
    </div>,
    document.body,
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-white/60">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full text-lg hover:bg-white/20"
    >
      {children}
    </button>
  );
}
