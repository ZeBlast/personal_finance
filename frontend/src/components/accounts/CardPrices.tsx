import { useEffect, useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";

interface RunCost {
  toFind: number;
  toRefresh: number;
  withoutId: number;
  requests: number;
  dailyRemaining: number;
  monthlyRemaining: number;
}

export interface PriceRunStatus {
  running: boolean;
  phase: string;
  itemsInRun: number;
  matched: number;
  notFound: number;
  priced: number;
  upToDate: number;
  idsFound: number;
  requests: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  plan: string | null;
  finishedAt: string | null;
  stoppedReason: string | null;
  error: string | null;
}

/** How many cards the test run covers: one free-plan batch. */
const TEST_SIZE = 20;

function KeyForm({ onSaved, onCancel }: { onSaved: () => void; onCancel?: () => void }) {
  const id = useId();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/card-prices/key", { method: "PUT", body: JSON.stringify({ apiKey: key }) });
      setKey("");
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not save the key."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
      <div className="min-w-64 flex-1">
        <label htmlFor={`${id}-key`} className="block text-xs font-medium">
          JustTCG API key
        </label>
        <input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="tcg_..."
          className={inputClass}
        />
      </div>
      <button type="submit" className={primaryClass} disabled={busy || key.trim().length < 8}>
        {busy ? "Saving..." : "Save key"}
      </button>
      {onCancel && (
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      )}
      {error && (
        <p role="alert" className="basis-full text-red-600">
          {error}
        </p>
      )}
      <p className="basis-full text-xs text-slate-500">
        Stored encrypted on this computer, and only sent to JustTCG. Get a free key at justtcg.com.
      </p>
    </form>
  );
}

function describe(s: PriceRunStatus): string {
  const parts = [
    s.running
      ? s.phase === "finding"
        ? "Finding cards on JustTCG"
        : s.phase === "refreshing"
          ? "Getting prices, 20 cards per request"
          : s.phase === "ids"
            ? "Looking up TCGplayer ids"
            : "Starting"
      : "Finished",
    `${s.priced} priced`,
    `${s.matched} found`,
    `${s.notFound} not found`,
  ];
  if (s.idsFound > 0) parts.push(`${s.idsFound} TCGplayer ids found`);
  if (s.upToDate > 0) parts.push(`${s.upToDate} already up to date`);
  parts.push(`${s.requests} requests used`);
  return parts.join(" · ");
}

/**
 * Market prices from JustTCG: the key, a test run on the first 20 cards (one batch), and a full
 * update. Runs happen in the background on the app's side; this polls their progress.
 */
export function CardPricesPanel({
  accountId,
  onUpdated,
}: {
  accountId: number;
  onUpdated: () => void;
}) {
  const key = useApi<{ saved: boolean }>("/card-prices/key");
  const [changingKey, setChangingKey] = useState(false);
  const [status, setStatus] = useState<PriceRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const testCost = useApi<RunCost>(
    `/accounts/${accountId}/collection/prices/cost?limit=${TEST_SIZE}`,
  );
  const fullCost = useApi<RunCost>(`/accounts/${accountId}/collection/prices/cost`);
  const reloadCosts = () => {
    testCost.reload();
    fullCost.reload();
  };

  // Picks up a run already going (the window was closed and opened again).
  useEffect(() => {
    void api<PriceRunStatus | null>(`/accounts/${accountId}/collection/prices/status`)
      .then((s) => setStatus(s))
      .catch(() => undefined);
  }, [accountId]);

  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void api<PriceRunStatus>(`/accounts/${accountId}/collection/prices/status`)
        .then((s) => {
          setStatus(s);
          if (!s.running) {
            onUpdated();
            reloadCosts();
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, accountId, onUpdated]);

  const left = fullCost.data;
  const costLabel = (c: RunCost | null) =>
    c
      ? c.requests === 0
        ? " (nothing to do)"
        : ` (~${c.requests} request${c.requests === 1 ? "" : "s"})`
      : "";
  const blocked = !!left && (left.dailyRemaining <= 0 || left.monthlyRemaining <= 0);

  const [lookingUp, setLookingUp] = useState(false);
  const [idNote, setIdNote] = useState<string | null>(null);
  async function lookUpIds(): Promise<void> {
    setLookingUp(true);
    setError(null);
    try {
      const r = await api<{
        found: number;
        notFound: Array<{ name: string; setCode: string; number: string }>;
      }>(`/accounts/${accountId}/collection/tcgplayer-ids`, { method: "POST" });
      setIdNote(
        `${r.found} TCGplayer ids found.` +
          (r.notFound.length > 0
            ? ` Not found: ${r.notFound
                .slice(0, 5)
                .map((n) => `${n.name} [${n.setCode}] ${n.number}`)
                .join("; ")}${r.notFound.length > 5 ? ` and ${r.notFound.length - 5} more` : ""}.`
            : ""),
      );
      onUpdated();
      reloadCosts();
    } catch (e) {
      setError(errorMessage(e, "Could not look up TCGplayer ids."));
    } finally {
      setLookingUp(false);
    }
  }

  const [confirmClear, setConfirmClear] = useState(false);
  async function clearPrices(): Promise<void> {
    setConfirmClear(false);
    setError(null);
    try {
      const r = await api<{ cleared: number }>(`/accounts/${accountId}/collection/prices/clear`, {
        method: "POST",
      });
      setStatus(null);
      setIdNote(
        `Prices cleared from ${r.cleared} cards. TCGplayer ids and values you typed in were kept.`,
      );
      onUpdated();
      reloadCosts();
    } catch (e) {
      setError(errorMessage(e, "Could not clear the prices."));
    }
  }

  async function start(limit?: number): Promise<void> {
    setError(null);
    try {
      setStatus(
        await api<PriceRunStatus>(`/accounts/${accountId}/collection/prices/update`, {
          method: "POST",
          body: JSON.stringify(limit ? { limit } : {}),
        }),
      );
    } catch (e) {
      setError(errorMessage(e, "Could not start the price update."));
    }
  }

  if (key.data && (!key.data.saved || changingKey)) {
    return (
      <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
        <p className="font-medium">Market prices</p>
        <KeyForm
          onSaved={() => {
            setChangingKey(false);
            key.reload();
          }}
          {...(changingKey ? { onCancel: () => setChangingKey(false) } : {})}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Market prices</p>
        <span className="flex-1" />
        {left && left.withoutId > 0 && (
          <button
            type="button"
            className={buttonClass}
            disabled={running || lookingUp}
            onClick={() => void lookUpIds()}
          >
            {lookingUp ? "Looking up..." : `Look up TCGplayer ids (${left.withoutId}, free)`}
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          disabled={running || blocked || testCost.data?.requests === 0}
          onClick={() => void start(TEST_SIZE)}
        >
          Test: first {TEST_SIZE} cards{costLabel(testCost.data)}
        </button>
        <button
          type="button"
          className={primaryClass}
          disabled={running || blocked || fullCost.data?.requests === 0}
          onClick={() => void start()}
        >
          Update all prices{costLabel(fullCost.data)}
        </button>
        <button
          type="button"
          className="text-xs text-slate-500 hover:underline"
          onClick={() => setChangingKey(true)}
        >
          Change key
        </button>
        <button
          type="button"
          className="text-xs text-red-700 hover:underline dark:text-red-400"
          disabled={running}
          onClick={() => setConfirmClear(true)}
        >
          Clear prices
        </button>
      </div>
      {confirmClear && (
        <div
          role="alertdialog"
          aria-label="Clear prices?"
          className="flex flex-wrap items-center gap-2 rounded-md bg-red-50 p-2 dark:bg-red-950"
        >
          <span className="flex-1">
            Remove all market prices, their history, and values that came from them? TCGplayer ids
            and values you typed in are kept. The next update fetches them again.
          </span>
          <button type="button" className={buttonClass} onClick={() => setConfirmClear(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={`${buttonClass} text-red-700 dark:text-red-400`}
            onClick={() => void clearPrices()}
          >
            Clear prices
          </button>
        </div>
      )}
      {left && (
        <p
          className={`text-xs ${blocked ? "text-amber-700 dark:text-amber-400" : "text-slate-600 dark:text-slate-300"}`}
        >
          JustTCG requests left: {left.dailyRemaining} today · {left.monthlyRemaining} this month.
          {left.withoutId > 0 && ` ${left.withoutId} cards have no TCGplayer id yet.`}
          {blocked && " Wait for the limit to reset before updating."}
        </p>
      )}
      <p className="text-xs text-slate-500">
        Cards are matched to TCGplayer by set code and number (free, from tcgcsv.com), then priced
        20 cards per request, not more than once a day; that also brings each card's price history.
        Cards are priced as Lightly Played unless their condition says otherwise. A card without a
        TCGplayer id costs one request of its own, once. The free plan allows 100 requests a day and
        1,000 a month. Values you typed in are kept.
      </p>
      {idNote && <p role="status">{idNote}</p>}
      {status && (
        <p role="status" className={status.error ? "text-red-600" : ""}>
          {describe(status)}
          {status.stoppedReason && (
            <span className="block text-amber-700">{status.stoppedReason}</span>
          )}
          {status.error && <span className="block">{status.error}</span>}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/** A card's market price over time, as a small line with its range. */
export function PriceHistory({
  accountId,
  itemId,
  title,
  currency,
  onClose,
}: {
  accountId: number;
  itemId: number;
  title: string;
  currency: string;
  onClose: () => void;
}) {
  const history = useApi<Array<{ day: string; priceMinor: number }>>(
    `/accounts/${accountId}/collection/items/${itemId}/prices`,
  );
  const points = history.data ?? [];
  const w = 600;
  const h = 120;
  const values = points.map((p) => p.priceMinor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i: number) => (points.length < 2 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v: number) => (max === min ? h / 2 : h - ((v - min) / (max - min)) * h);
  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
      <div className="flex items-center gap-2">
        <p className="font-medium">Price history: {title}</p>
        <span className="flex-1" />
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      </div>
      {history.data && points.length === 0 && (
        <p className="text-slate-500">No prices yet. Run a price update first.</p>
      )}
      {points.length > 0 && (
        <>
          <svg
            viewBox={`-4 -4 ${w + 8} ${h + 8}`}
            className="h-32 w-full max-w-2xl text-blue-600 dark:text-blue-400"
            role="img"
            aria-label={`From ${formatMinor(values[0]!, currency)} on ${points[0]!.day} to ${formatMinor(values.at(-1)!, currency)} on ${points.at(-1)!.day}`}
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              points={points.map((p, i) => `${x(i)},${y(p.priceMinor)}`).join(" ")}
            />
          </svg>
          <p className="text-xs text-slate-500">
            {points[0]!.day} to {points.at(-1)!.day} · low {formatMinor(min, currency)} · high{" "}
            {formatMinor(max, currency)} · latest {formatMinor(values.at(-1)!, currency)}
          </p>
        </>
      )}
    </div>
  );
}
