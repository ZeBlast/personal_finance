import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { Loading } from "../components/common/Loading";
import { AddressLookups } from "../components/places/AddressLookups";
import { HabitBarcodes } from "../components/places/HabitBarcodes";
import { PlaceDetail } from "../components/places/PlaceDetail";
import { PlacesMap } from "../components/places/PlacesMap";
import { RhythmGrid } from "../components/places/RhythmGrid";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { shiftMonth, today } from "../lib/period";
import {
  beaconsAt,
  filterPurchases,
  groupPlaces,
  habits,
  mapStyle,
  purchasesAt,
  rhythm,
  type Bounds,
} from "../lib/places";
import { usePersistentState } from "../hooks/usePersistentState";
import { formatDay } from "../lib/time";
import { toast } from "../lib/toast";
import type { Settings } from "../types/api";
import type { Places } from "../types/places";

const SPANS = [
  { months: 3, label: "Last 3 months" },
  { months: 6, label: "Last 6 months" },
  { months: 12, label: "Last 12 months" },
  { months: 24, label: "Last 2 years" },
];
/** Replay shows the purchases of this many days up to the day on the slider. */
const REPLAY_DAYS = 60;
const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Reports > Places & rhythm: where you spend, when in the week, and the shops that are habits. */
export function PlacesPage() {
  const now = today();
  const [months, setMonths] = useState(12);
  const from = `${shiftMonth(now.slice(0, 7), -months)}-${now.slice(8, 10) > "28" ? "28" : now.slice(8, 10)}`;
  const { data, error, loading, reload } = useApi<Places>(`/places?from=${from}&to=${now}`);
  const settings = useApi<Settings>("/settings");
  const online = settings.data?.mapTilesOnline ?? false;
  const theme = settings.data?.mapTheme ?? "auto";
  const systemDark =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  const look = mapStyle(theme, online, systemDark);
  // Purchases paid online have no shop to visit, so they stay off the map unless asked for.
  const [showOnline, setShowOnline] = usePersistentState("pf.places.online", false);
  const money = (n: number) => formatMinor(n, data?.currency ?? "USD");

  const [cells, setCells] = useState<Set<string>>(new Set());
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [inView, setInView] = useState(false);
  const [replayEnd, setReplayEnd] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  // Playing moves the replay a week at a time to today, then stops.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setReplayEnd((end) => {
        const next = addDays(end ?? addDays(from, REPLAY_DAYS), 7);
        if (next >= now) {
          setPlaying(false);
          return now;
        }
        return next;
      });
    }, 350);
    return () => clearInterval(timer);
  }, [playing, from, now]);

  const purchases = useMemo(() => data?.purchases ?? [], [data]);
  const shown = useMemo(() => {
    const timed = filterPurchases(purchases, { cells, online: showOnline });
    if (replayEnd === null) return timed;
    const start = addDays(replayEnd, -REPLAY_DAYS);
    return timed.filter((p) => p.date > start && p.date <= replayEnd);
  }, [purchases, cells, replayEnd, showOnline]);
  // During a replay, the purchases of its latest week send out a beacon.
  const beacons = useMemo(
    () => (replayEnd === null ? [] : beaconsAt(shown, replayEnd, 7)),
    [shown, replayEnd],
  );
  const places = useMemo(() => groupPlaces(shown), [shown]);
  // The place picked on the map, while it is still among those shown (a filter may drop it).
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const picked = places.find((p) => p.key === pickedKey) ?? null;
  const area = inView && bounds ? bounds : undefined;
  const week = useMemo(
    () => rhythm(filterPurchases(purchases, { bounds: area })),
    [purchases, area],
  );
  const regulars = useMemo(
    () => habits(filterPurchases(purchases, { cells, bounds: area })),
    [purchases, cells, area],
  );

  async function saveSetting(patch: Partial<Settings>): Promise<void> {
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      settings.reload();
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    }
  }

  const toggleCell = (key: string) => {
    const next = new Set(cells);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCells(next);
  };

  const summary = data
    ? data.counted === 0
      ? "No purchases in this period yet."
      : `${data.withPlace} of ${data.counted} purchases have a place, and ${data.withTime} a time of day.`
    : "Where you spend, when in the week, and the shops that have become habits.";

  return (
    <section className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Places &amp; rhythm</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{summary}</p>
        </div>
        <label className="text-sm">
          <span className="sr-only">Period</span>
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
            value={months}
            onChange={(e) => {
              setMonths(Number(e.target.value));
              setReplayEnd(null);
              setPlaying(false);
            }}
          >
            {SPANS.map((s) => (
              <option key={s.months} value={s.months}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {loading && !data && <Loading lines={8} />}

      {data && (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Where</h2>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showOnline}
                    onChange={(e) => setShowOnline(e.target.checked)}
                  />
                  Online purchases
                </label>
                <label className="flex items-center gap-2">
                  Map colours
                  <select
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
                    value={theme}
                    disabled={!settings.data}
                    onChange={(e) =>
                      void saveSetting({ mapTheme: e.target.value as Settings["mapTheme"] })
                    }
                  >
                    <option value="auto">Match the app</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={online}
                    disabled={!settings.data}
                    onChange={(e) => void saveSetting({ mapTilesOnline: e.target.checked })}
                  />
                  Show map images (from OpenFreeMap)
                </label>
              </div>
            </div>
            {!online && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Off, so nothing is fetched: places are drawn on a plain background. Turned on, the
                map host sees which areas you look at, never your transactions.
              </p>
            )}
            <PlacesMap
              places={places}
              today={now}
              look={look}
              money={money}
              onBounds={setBounds}
              frameKey={data.withPlace}
              animate={replayEnd !== null}
              beacons={beacons}
              selectedKey={picked?.key ?? null}
              onSelect={(place) => setPickedKey(place?.key ?? null)}
              detail={
                picked && (
                  <PlaceDetail
                    place={picked}
                    purchases={purchasesAt(shown, picked.key)}
                    money={money}
                    onClose={() => setPickedKey(null)}
                  />
                )
              }
            />
            <AddressLookups onFound={reload} />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                onClick={() => {
                  if (playing) {
                    setPlaying(false);
                    return;
                  }
                  if (replayEnd === null || replayEnd >= now)
                    setReplayEnd(addDays(from, REPLAY_DAYS));
                  setPlaying(true);
                }}
                className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
              >
                {playing ? "Pause" : "Replay"}
              </button>
              <input
                type="range"
                aria-label="Replay up to"
                className="min-w-48 flex-1"
                min={0}
                max={Math.max(1, Math.round((Date.parse(now) - Date.parse(from)) / DAY_MS))}
                value={
                  replayEnd === null
                    ? Math.round((Date.parse(now) - Date.parse(from)) / DAY_MS)
                    : Math.round((Date.parse(replayEnd) - Date.parse(from)) / DAY_MS)
                }
                onChange={(e) => {
                  setPlaying(false);
                  setReplayEnd(addDays(from, Number(e.target.value)));
                }}
              />
              <span className="w-56 text-slate-600 dark:text-slate-300">
                {replayEnd === null
                  ? "Showing the whole period"
                  : `${REPLAY_DAYS} days up to ${formatDay(replayEnd)}`}
              </span>
              {replayEnd !== null && (
                <button
                  type="button"
                  className="text-blue-700 hover:underline dark:text-blue-400"
                  onClick={() => {
                    setPlaying(false);
                    setReplayEnd(null);
                  }}
                >
                  Show all
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Circle size is what you spent there; each thin ring is a month you went; a dashed
              outline is an approximate position (a street, postal code or city). Click a circle for
              its purchases. Blue is recent, fading to grey for places you have not been to in a
              while.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">When</h2>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={inView}
                    onChange={(e) => setInView(e.target.checked)}
                  />
                  Only what is in view on the map
                </label>
                {cells.size > 0 && (
                  <button
                    type="button"
                    className="text-blue-700 hover:underline dark:text-blue-400"
                    onClick={() => setCells(new Set())}
                  >
                    Clear the hours chosen ({cells.size})
                  </button>
                )}
              </div>
            </div>
            <RhythmGrid rhythm={week} chosen={cells} onToggle={toggleCell} money={money} />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Bigger circles are more purchases; darker ones cost more on average. Click hours to
              see only those on the map and in the habits below. Times are in this computer&apos;s
              time zone.
            </p>
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Habits</h2>
            <HabitBarcodes
              habits={regulars}
              narrowed={cells.size > 0 || area !== undefined}
              from={purchases[0] && purchases[0].date > from ? purchases[0].date : from}
              to={now}
            />
          </div>
        </>
      )}
    </section>
  );
}
