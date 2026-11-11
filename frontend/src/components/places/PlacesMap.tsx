import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { recency, type Bounds, type Place } from "../../lib/places";
import type { PlacePurchase } from "../../types/places";

/**
 * The map of places. Each place is a circle sized by what was spent there, with one thin ring for
 * every month it was visited (up to a year), and coloured by how recently: bright for this month,
 * fading to grey for places you have stopped going to. A dashed outline means the position is
 * only approximate (a postal code's or city's, from an address lookup).
 *
 * During a replay, places pop in as they are first visited in the window and fade out as it moves
 * past them, and each purchase sends out a beacon where it happened. All of it rests when the
 * system asks for reduced motion (see index.css).
 *
 * The map images come from OpenFreeMap (OpenStreetMap data) only when the user allows it, in its
 * light or dark style; otherwise the places are drawn on a plain background, and nothing is fetched.
 */

// The map library looks for its worker file beside its own code, which a bundle does not keep
// there: this is where the build put it. (It stays on this origin, as the app's CSP requires.)
setWorkerUrl(workerUrl);

function plainStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": dark ? "#0f172a" : "#f1f5f9" },
      },
    ],
  };
}

const MAX_RINGS = 12;
/** How long a place takes to fade out, matching `pf-place-out` in index.css. */
const LEAVE_MS = 450;

/** A colour from grey (stale) to blue (fresh), lighter on a dark map. Pure. */
function freshColour(fresh: number, dark: boolean): string {
  const saturation = Math.round(15 + 70 * fresh);
  const lightness = dark ? Math.round(55 + 15 * fresh) : Math.round(60 - 12 * fresh);
  return `hsl(215 ${saturation}% ${lightness}%)`;
}

export function PlacesMap({
  places,
  today,
  look,
  money,
  onBounds,
  frameKey,
  animate = false,
  beacons = [],
  selectedKey = null,
  onSelect,
  detail,
}: {
  places: Place[];
  today: string;
  /** Map images (and their URL) or a plain background, light or dark. */
  look: { online: boolean; url: string | null; dark: boolean };
  money: (n: number) => string;
  onBounds: (b: Bounds) => void;
  /** When this changes (say, address lookups placed more purchases), the map frames the places again. */
  frameKey?: string | number;
  /** A replay is running: places fade out as they leave it. */
  animate?: boolean;
  /** Purchases to send a beacon from, where they happened. */
  beacons?: PlacePurchase[];
  /** The place picked by a click (its dot is ringed), and what a click on a dot or off them does. */
  selectedKey?: string | null;
  onSelect?: (place: Place | null) => void;
  /** Shown over the map's right side while a place is picked: its purchases. */
  detail?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const fitted = useRef(false);
  // Bumped on every move, so the circles follow the map.
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<Place | null>(null);
  const [leaving, setLeaving] = useState<Place[]>([]);
  const previous = useRef<Place[]>(places);
  const boundsRef = useRef(onBounds);
  boundsRef.current = onBounds;
  const placesRef = useRef(places);
  placesRef.current = places;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  /** Frames the places once, after the map has loaded (a style applies its own view as it loads). */
  const frame = (m: MapLibreMap): void => {
    const shown = placesRef.current;
    if (fitted.current || shown.length === 0 || !m.isStyleLoaded()) return;
    const lons = shown.map((p) => p.lon);
    const lats = shown.map((p) => p.lat);
    m.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 48, maxZoom: 14, duration: 0 },
    );
    fitted.current = true;
  };

  useEffect(() => {
    if (!box.current) return;
    const m = new MapLibreMap({
      container: box.current,
      style: look.url ?? plainStyle(look.dark),
      center: [-95, 39],
      zoom: 3,
      attributionControl: look.online ? { compact: true } : false,
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    const moved = () => {
      setTick((n) => n + 1);
      const b = m.getBounds();
      boundsRef.current({
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      });
    };
    m.on("move", moved);
    // A click on the map itself (the dots sit above it and take their own) puts the place away.
    m.on("click", () => selectRef.current?.(null));
    m.on("load", () => {
      frame(m);
      moved();
    });
    map.current = m;
    fitted.current = false;
    return () => {
      m.remove();
      map.current = null;
    };
    // Rebuilt only when the look changes; `frame` reads the latest places through a ref.
  }, [look.online, look.url, look.dark]);

  // Frame them again when told to.
  useEffect(() => {
    fitted.current = false;
  }, [frameKey]);

  // Frame the places the first time there are some.
  useEffect(() => {
    if (map.current) frame(map.current);
  });

  // During a replay, places that drop out of the window fade out instead of vanishing.
  useEffect(() => {
    const now = new Set(places.map((p) => p.key));
    const gone = animate ? previous.current.filter((p) => !now.has(p.key)) : [];
    previous.current = places;
    if (gone.length === 0) return;
    const timer = setTimeout(() => setLeaving([]), LEAVE_MS);
    setLeaving(gone);
    return () => clearTimeout(timer);
  }, [places, animate]);

  const m = map.current;
  const biggest = Math.max(1, ...places.map((p) => p.totalMinor));
  const radius = (p: Place) => 4 + 16 * Math.sqrt(Math.min(p.totalMinor, biggest) / biggest);
  // Smallest drawn last, so it stays clickable on top of a big neighbour.
  const drawn = [...places].sort((a, b) => b.totalMinor - a.totalMinor);

  const drawPlace = (p: Place, out: boolean) => {
    if (!m) return null;
    const at = m.project([p.lon, p.lat]);
    const r = radius(p);
    const fresh = recency(p.lastDate, today);
    const colour = freshColour(fresh, look.dark);
    const rings = Math.min(p.months.length, MAX_RINGS);
    const dash = p.approx ? "3 2" : undefined;
    return (
      <g
        key={`${out ? "out" : "in"}-${p.key}`}
        className={`${out ? "pf-place-out" : "pf-place-in pointer-events-auto cursor-pointer"}`}
        onClick={out ? undefined : () => onSelect?.(p.key === selectedKey ? null : p)}
        onMouseEnter={out ? undefined : () => setHover(p)}
        onMouseLeave={out ? undefined : () => setHover((h) => (h?.key === p.key ? null : h))}
      >
        {Array.from({ length: rings }, (_, i) => (
          <circle
            key={i}
            cx={at.x}
            cy={at.y}
            r={r + 2 + i * 2.5}
            fill="none"
            stroke={colour}
            strokeOpacity={0.55 - (0.35 * i) / MAX_RINGS}
            strokeWidth={1}
            strokeDasharray={dash}
          />
        ))}
        <circle
          cx={at.x}
          cy={at.y}
          r={r}
          fill={colour}
          fillOpacity={(p.approx ? 0.2 : 0.35) + 0.45 * fresh}
          stroke={colour}
          strokeWidth={1.5}
          strokeDasharray={dash}
        />
        {!out && p.key === selectedKey && (
          <circle
            data-testid="selected-place"
            cx={at.x}
            cy={at.y}
            r={r + 4}
            fill="none"
            stroke={look.dark ? "#fbbf24" : "#b45309"}
            strokeWidth={2.5}
          />
        )}
      </g>
    );
  };

  /** Frames every place again, after moving around. */
  const showAll = (): void => {
    if (!m) return;
    fitted.current = false;
    frame(m);
  };

  return (
    <div className="relative h-[max(28rem,min(60vh,44rem))] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      {/* MapLibre makes this element position: relative, so it is sized by height, not inset. */}
      <div ref={box} className="h-full w-full" />
      {m && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          {leaving.map((p) => drawPlace(p, true))}
          {drawn.map((p) => drawPlace(p, false))}
          {beacons.map((b) => {
            if (b.lat === null || b.lon === null) return null;
            const at = m.project([b.lon, b.lat]);
            return (
              <circle
                key={`beacon-${b.id}`}
                className="pf-beacon"
                cx={at.x}
                cy={at.y}
                r={9}
                fill="none"
                stroke={look.dark ? "#fbbf24" : "#d97706"}
                strokeWidth={2.5}
              />
            );
          })}
        </svg>
      )}
      {places.length > 0 && (
        <button
          type="button"
          onClick={showAll}
          className="absolute bottom-2 left-2 rounded-md border border-slate-300 bg-white/95 px-2 py-1 text-xs shadow-sm hover:bg-white dark:border-slate-600 dark:bg-slate-800/95 dark:hover:bg-slate-800"
        >
          Show all places
        </button>
      )}
      {detail && (
        <div className="absolute inset-y-2 right-12 flex w-80 max-w-[calc(100%-4rem)] flex-col overflow-hidden rounded-md border border-slate-200 bg-white/95 text-sm shadow-lg dark:border-slate-600 dark:bg-slate-800/95">
          {detail}
        </div>
      )}
      {hover && (
        <div className="pointer-events-none absolute top-2 left-2 max-w-64 rounded-md bg-white/95 p-2 text-xs shadow dark:bg-slate-800/95">
          <div className="font-semibold">{hover.merchant}</div>
          <div>
            {money(hover.totalMinor)} over {hover.visits} {hover.visits === 1 ? "visit" : "visits"},
            in {hover.months.length} {hover.months.length === 1 ? "month" : "months"}
          </div>
          <div className="text-slate-500 dark:text-slate-400">
            Last on {hover.lastDate}
            {hover.city ? `, ${hover.city}` : ""}
          </div>
          {hover.key !== selectedKey && onSelect && (
            <div className="text-slate-500 dark:text-slate-400">Click for its purchases</div>
          )}
          {hover.approx && (
            <div className="text-amber-700 dark:text-amber-300">
              Approximate position (street, postal code or city)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
