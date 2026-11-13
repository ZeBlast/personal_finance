import { X } from "lucide-react";
import { Link } from "react-router-dom";
import type { Place } from "../../lib/places";
import { formatDay } from "../../lib/time";
import { foundText } from "../../lib/lookupReview";
import type { Lookup, PlacePurchase } from "../../types/places";
import { LookupActions, type LookupHandlers } from "./LookupReview";

/** "3:42 PM" on this computer's clock, from the time the bank sent. */
const timeOf = (datetime: string): string =>
  new Date(datetime).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * A place picked on the map: what was spent there, and every purchase behind its dot, newest
 * first. Each purchase opens in Transactions, where it can be edited. When an address lookup put
 * the place here, it says what the lookup found, to be called right or wrong, or moved.
 */
export function PlaceDetail({
  place,
  purchases,
  money,
  onClose,
  lookup = null,
  review,
}: {
  place: Place;
  /** This place's purchases among those on the map now, newest first. */
  purchases: PlacePurchase[];
  money: (n: number) => string;
  onClose: () => void;
  /** The address lookup that put this place here, when one did. */
  lookup?: Lookup | null;
  /** What its buttons do; without it they are not shown. */
  review?: LookupHandlers | undefined;
}) {
  // A position set by hand is kept on the lookup that names this shop itself.
  const moveKey = purchases.find((p) => p.moveKey !== null)?.moveKey ?? null;
  return (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 p-3 dark:border-slate-600">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{place.merchant}</h3>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {money(place.totalMinor)} over {place.visits} {place.visits === 1 ? "visit" : "visits"}
            {place.city ? ` · ${place.city}` : ""}
          </p>
          {place.approx && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Approximate position (street, postal code or city)
            </p>
          )}
          {lookup && (
            <div className="mt-1 space-y-1 text-xs text-slate-600 dark:text-slate-300">
              <p>
                {lookup.verdict === "moved"
                  ? "You set this position yourself."
                  : `Placed by an address lookup. ${foundText(lookup)}${
                      lookup.verdict === "right" ? ". You said this is right." : ""
                    }`}
              </p>
              {review && (
                <LookupActions
                  lookup={lookup}
                  moveKey={moveKey}
                  label={place.merchant}
                  {...review}
                />
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-700"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-700">
        {purchases.map((p) => (
          <li key={p.id}>
            <Link
              to={`/transactions?focus=${p.id}&account=${p.accountId}`}
              title="Open in Transactions"
              className="flex items-center justify-between gap-3 px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700/60"
            >
              <span className="min-w-0">
                <span className="block">
                  {formatDay(p.date)}
                  {p.datetime ? `, ${timeOf(p.datetime)}` : ""}
                </span>
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                  {p.category ?? "Uncategorized"}
                  {p.online ? " · online" : ""}
                </span>
              </span>
              <span className="tabular-nums">{money(p.amountMinor)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-600 dark:text-slate-400">
        A purchase opens in Transactions.
      </p>
    </>
  );
}
