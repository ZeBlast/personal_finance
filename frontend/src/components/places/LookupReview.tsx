import { X } from "lucide-react";
import { useState } from "react";
import {
  foundText,
  inTab,
  isAnswered,
  isApproximate,
  precisionLabel,
  purchasesText,
  REVIEW_TABS,
  tabCounts,
  verdictText,
  type ReviewTab,
} from "../../lib/lookupReview";
import { formatDay } from "../../lib/time";
import type { Lookup } from "../../types/places";

const button =
  "rounded-md border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-800";

/** What the buttons of a lookup do; the same in the list and in a place's panel. */
export interface LookupHandlers {
  busy: boolean;
  onVerdict: (lookup: Lookup, verdict: "right" | "wrong") => void;
  /** Starts choosing a position on the map for the lookup with this key. */
  onMove: (key: string, label: string) => void;
  onUndo: (lookup: Lookup) => void;
}

/** The buttons for one lookup: your call on it, or taking that call back. */
export function LookupActions({
  lookup,
  moveKey,
  label,
  busy,
  onVerdict,
  onMove,
  onUndo,
}: LookupHandlers & {
  lookup: Lookup;
  /** The lookup a position set by hand is kept on; null when there is none to move. */
  moveKey: string | null;
  /** What is being placed, for the prompt while choosing a position. */
  label: string;
}) {
  const judged = lookup.verdict !== null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {/* Right and wrong are about the server's answer, so there has to be one. */}
      {!judged && isAnswered(lookup) && (
        <>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => onVerdict(lookup, "right")}
          >
            Right
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => onVerdict(lookup, "wrong")}
          >
            Wrong
          </button>
        </>
      )}
      {moveKey !== null && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => onMove(moveKey, label)}
        >
          {lookup.lat === null ? "Set position" : "Move"}
        </button>
      )}
      {judged && (
        <button type="button" className={button} disabled={busy} onClick={() => onUndo(lookup)}>
          Undo
        </button>
      )}
    </span>
  );
}

/**
 * Every address lookup, to check against the map: what was asked, what the lookup server says it
 * found, how close that is, and how many purchases it places. Click one to see it on the map; say
 * whether it is right or wrong, or set the position yourself. Nothing here is sent anywhere.
 */
export function LookupReview({
  lookups,
  shownKey,
  onShow,
  onClose,
  ...handlers
}: LookupHandlers & {
  lookups: Lookup[];
  /** The lookup marked on the map now. */
  shownKey: string | null;
  onShow: (lookup: Lookup) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ReviewTab>("check");
  const counts = tabCounts(lookups);
  const rows = inTab(lookups, tab);
  return (
    <div
      role="region"
      aria-label="Looked-up positions"
      className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Which lookups" className="flex flex-wrap gap-1">
          {REVIEW_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-2.5 py-1 ${
                tab === t.id
                  ? "bg-slate-200 font-medium dark:bg-slate-700"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {t.label} ({counts[t.id]})
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Close the list"
          onClick={onClose}
          className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-700"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">
          {tab === "check"
            ? "Nothing to check."
            : tab === "checked"
              ? "You have not checked any yet."
              : "Every shop and address looked up was found."}
        </p>
      ) : (
        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-700">
          {rows.map((l) => (
            <li
              key={l.key}
              className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-1 py-2 ${
                l.key === shownKey ? "bg-amber-50 dark:bg-amber-900/20" : ""
              }`}
            >
              <button
                type="button"
                disabled={l.lat === null}
                title={l.lat === null ? undefined : "Show on the map"}
                onClick={() => onShow(l)}
                className="min-w-0 flex-1 basis-72 text-left enabled:hover:underline"
              >
                <span className="block font-medium">
                  {l.shop ? `${l.shop} · ` : ""}
                  {l.asked}
                </span>
                <span className="block text-xs text-slate-600 dark:text-slate-300">
                  {foundText(l)}
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  <span
                    className={isApproximate(l) ? "text-amber-700 dark:text-amber-300" : undefined}
                  >
                    {precisionLabel(l.precision)}
                    {isApproximate(l) ? " (approximate)" : ""}
                  </span>
                  {` · ${purchasesText(l)}`}
                  {l.lookedUpAt ? ` · looked up ${formatDay(l.lookedUpAt.slice(0, 10))}` : ""}
                </span>
                {verdictText(l) && (
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {verdictText(l)}
                  </span>
                )}
              </button>
              <LookupActions
                lookup={l}
                moveKey={l.canMove ? l.key : null}
                label={l.shop ?? l.asked}
                {...handlers}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Wrong: the answer is no longer used. A purchase with a street address then leaves the map;
        one without is placed by its postal code or city at the next lookups. Move: click the map
        where the shop is. Your calls are kept when everything is looked up again. A postal
        code&apos;s or city&apos;s position is shared by every purchase there, so it cannot be
        moved: set the shop&apos;s own position under Found nothing.
      </p>
    </div>
  );
}
