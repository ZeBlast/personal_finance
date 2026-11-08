import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { recency, type Bounds, type Place } from "../../lib/places";

/**
 * The map of places. Each place is a circle sized by what was spent there, with one thin ring for
 * every month it was visited (up to a year), and coloured by how recently: bright for this month,
 * fading to grey for places you have stopped going to.
 *
 * The map images come from OpenFreeMap (OpenStreetMap data) only when the user allows it; otherwise
 * the places are drawn on a plain background, and nothing is fetched.
 */

export const ONLINE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const dark = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;

function plainStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": dark() ? "#0f172a" : "#f1f5f9" },
      },
    ],
  };
}

const MAX_RINGS = 12;

/** A colour from grey (stale) to blue (fresh). Pure. */
function freshColour(fresh: number): string {
  const hue = 215;
  const saturation = Math.round(15 + 70 * fresh);
  const lightness = Math.round(60 - 12 * fresh);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

export function PlacesMap({
  places,
  today,
  online,
  money,
  onBounds,
}: {
  places: Place[];
  today: string;
  online: boolean;
  money: (n: number) => string;
  onBounds: (b: Bounds) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const fitted = useRef(false);
  // Bumped on every move, so the circles follow the map.
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<Place | null>(null);
  const boundsRef = useRef(onBounds);
  boundsRef.current = onBounds;
  const placesRef = useRef(places);
  placesRef.current = places;

  /** Frames the places once, after the map has loaded (a style applies its own view as it loads). */
  const frame = (m: MapLibreMap): void => {
    const shown = placesRef.current;
    if (fitted.current || shown.length === 0 || !m.loaded()) return;
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
    const m = new maplibregl.Map({
      container: box.current,
      style: online ? ONLINE_STYLE : plainStyle(),
      center: [-95, 39],
      zoom: 3,
      attributionControl: online ? { compact: true } : false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
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
  }, [online]);

  // Frame the places the first time there are some.
  useEffect(() => {
    if (map.current) frame(map.current);
  });

  const m = map.current;
  const biggest = Math.max(1, ...places.map((p) => p.totalMinor));
  // Smallest drawn last, so it stays clickable on top of a big neighbour.
  const drawn = [...places].sort((a, b) => b.totalMinor - a.totalMinor);

  return (
    <div className="relative h-[28rem] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      {/* MapLibre makes this element position: relative, so it is sized by height, not inset. */}
      <div ref={box} className="h-full w-full" />
      {m && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          {drawn.map((p) => {
            const at = m.project([p.lon, p.lat]);
            const r = 4 + 16 * Math.sqrt(p.totalMinor / biggest);
            const fresh = recency(p.lastDate, today);
            const colour = freshColour(fresh);
            const rings = Math.min(p.months.length, MAX_RINGS);
            return (
              <g
                key={p.key}
                className="pointer-events-auto cursor-pointer"
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover((h) => (h?.key === p.key ? null : h))}
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
                  />
                ))}
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={r}
                  fill={colour}
                  fillOpacity={0.35 + 0.45 * fresh}
                  stroke={colour}
                  strokeWidth={1.5}
                />
              </g>
            );
          })}
        </svg>
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
        </div>
      )}
    </div>
  );
}
