import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { announceDataChanged } from "../../lib/syncEvents";
import type { CardBill } from "../../types/planning";

/** Cards whose closing and due days are set but whose bill is not counted in the forecast. Pure. */
export function billsReadyToCount(bills: CardBill[]): CardBill[] {
  return bills.filter(
    (b) => b.settings === null && b.statementDays !== null && b.statementDays.dueDay !== null,
  );
}

/**
 * One step for every card whose statement days are already set: count all their bills in the cash
 * forecast (and track what has been paid), with the days they have. Shown only when two or more
 * cards wait, since one card has its own button. A card can still be edited afterwards for its
 * minimum payment or autopay.
 */
export function CountAllBills({ bills, onDone }: { bills: CardBill[]; onDone: () => void }) {
  const ready = billsReadyToCount(bills);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (ready.length < 2) return null;

  async function countAll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      for (const b of ready) {
        await api(`/accounts/${b.accountId}/bill`, {
          method: "PUT",
          body: JSON.stringify({
            closingDay: b.statementDays!.closingDay,
            dueDay: b.statementDays!.dueDay,
            minimumMinor: null,
            autopay: false,
          }),
        });
      }
    } catch (e) {
      setError(errorMessage(e, "Could not count every bill. Try them one at a time."));
    } finally {
      setBusy(false);
      onDone();
      announceDataChanged();
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
      <span>
        {ready.length} cards have their statement days set, but their bills are not counted in the
        cash forecast or tracked as paid.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void countAll()}
        className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
      >
        {busy ? "Counting..." : `Count all ${ready.length} in the forecast`}
      </button>
      {error && (
        <span role="alert" className="basis-full text-xs text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}
