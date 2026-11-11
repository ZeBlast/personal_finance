import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, insideTauri } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { lookupProgress, resetNote } from "../../lib/geocode";
import { askConfirm } from "../common/ConfirmHost";
import { toast } from "../../lib/toast";
import type { GeocodeStatus } from "../../types/places";

export const POLICY_URL = "https://operations.osmfoundation.org/policies/nominatim/";
const COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

/** A link that opens in the default browser from the desktop window. */
function Outside({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-blue-700 underline dark:text-blue-300"
      onClick={(e) => {
        if (insideTauri) {
          e.preventDefault();
          void openUrl(href);
        }
      }}
    >
      {children}
    </a>
  );
}

/**
 * Finding map positions for purchases that came without one, with Nominatim (OpenStreetMap), from
 * the street address, the shop and its city, the postal code or the city. Off until turned on;
 * runs only when started here, one lookup every two seconds, with a progress bar while it goes.
 * The backend keeps every answer, so nothing is asked twice; "look up all again" clears them, at
 * most once a week.
 */
export function AddressLookups({ onFound }: { onFound: () => void }) {
  const { data, error, reload } = useApi<GeocodeStatus>("/geocode/status");
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const wasRunning = useRef(false);

  // Follow a run once a second; when it ends, show the places it found.
  useEffect(() => {
    if (!data) return;
    if (wasRunning.current && !data.running) onFound();
    wasRunning.current = data.running;
    if (!data.running) return;
    const timer = setTimeout(reload, 1000);
    return () => clearTimeout(timer);
  }, [data, reload, onFound]);

  async function send(path: string, init: RequestInit): Promise<void> {
    setBusy(true);
    try {
      await api(path, init);
      reload();
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }
  const patch = (body: object) =>
    send("/settings", { method: "PATCH", body: JSON.stringify(body) });

  async function lookUpAllAgain(): Promise<void> {
    const ok = await askConfirm({
      title: "Look everything up again?",
      message:
        "Every saved answer is forgotten and asked again, one every 2 seconds, so any change in how lookups are done applies to all of them. To spare the lookup server, this can be done once a week.",
      confirmLabel: "Look everything up again",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api("/geocode/reset", { method: "POST" });
      await api("/geocode/start", { method: "POST" });
    } catch (e) {
      toast(errorMessage(e), { kind: "error" });
    } finally {
      setBusy(false);
      reload();
    }
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }
  if (!data) return null;
  const progress = lookupProgress(data);
  const button =
    "rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-800";

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={data.enabled}
            disabled={busy || data.running}
            onChange={(e) => void patch({ geocodeEnabled: e.target.checked })}
          />
          Look up street addresses and shops with OpenStreetMap (Nominatim)
        </label>
        {data.enabled &&
          (data.running ? (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void send("/geocode/stop", { method: "POST" })}
            >
              Stop
            </button>
          ) : (
            <span className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                disabled={busy || data.pending === 0}
                onClick={() => void send("/geocode/start", { method: "POST" })}
              >
                {data.pending === 0 ? "Nothing to look up" : "Start lookups"}
              </button>
              <button
                type="button"
                className={button}
                disabled={busy || data.resetAvailableAt !== null}
                title={resetNote(data) ?? undefined}
                onClick={() => void lookUpAllAgain()}
              >
                Look up all again
              </button>
            </span>
          ))}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Some purchases come without a map position. Turned on, the app looks them up when you press
        Start. One with a street address is looked up by that address only; one without, by the
        shop&apos;s name and city, then by the postal code or city. An answer is kept only when it
        fits what was asked (the right state, a shop of that name); one that is only the street,
        postal code or city shows as approximate, with a dashed outline. It sends what is known
        about the shop and where it is (never amounts, dates or anything about you), one lookup
        every 2 seconds, and keeps every answer so nothing is asked twice. Follows the{" "}
        <Outside href={POLICY_URL}>Nominatim usage policy</Outside>.
      </p>
      {data.enabled && resetNote(data) && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Look up all again: {resetNote(data)}
        </p>
      )}

      {(data.running || data.stopped !== null || data.total > 0 || data.enabled) && (
        <div className="space-y-1" aria-live="polite">
          {progress.percent !== null && (
            <div
              role="progressbar"
              aria-label="Address lookups"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              className="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"
            >
              <div
                className="h-2 rounded bg-blue-600 transition-[width] duration-700"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          )}
          <p
            className={
              progress.tone === "warn"
                ? "text-amber-700 dark:text-amber-300"
                : "text-slate-600 dark:text-slate-300"
            }
          >
            {progress.text} {progress.eta}
          </p>
        </div>
      )}

      <details className="text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer">Lookup server</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            aria-label="Lookup server"
            className="min-w-72 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
            value={server ?? data.server}
            onChange={(e) => setServer(e.target.value)}
          />
          <button
            type="button"
            className={button}
            disabled={busy || data.running || server === null || server === data.server}
            onClick={() => void patch({ geocodeServer: server }).then(() => setServer(null))}
          >
            Save
          </button>
        </div>
        <p className="mt-1">
          Change this only to use your own Nominatim server or another provider, or if the
          OpenStreetMap Foundation asks apps to move.
        </p>
      </details>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Address positions by Nominatim, ©{" "}
        <Outside href={COPYRIGHT_URL}>OpenStreetMap contributors</Outside> (ODbL).
      </p>
    </div>
  );
}
