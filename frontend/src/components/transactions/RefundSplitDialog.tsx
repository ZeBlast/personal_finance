import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import type { Category, RefundAllocation, Transaction } from "../../types/api";
import { Modal } from "../common/Modal";
import { useUnsavedGuard } from "../common/useUnsavedGuard";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { amountsFromPercents } from "./SplitDialog";

const minorToText = (minor: number): string => (minor / 100).toFixed(2);

/**
 * The amounts typed for each category as a split request, or what is wrong: each amount at most
 * what is left in its category, together the whole refund. Pure, so it can be tested.
 */
export function buildRefundSplit(
  allocation: RefundAllocation,
  amounts: string[],
  currency: string,
):
  | { ok: true; parts: Array<{ categoryId: number | null; amountMinor: number }> }
  | { ok: false; message: string } {
  const parts = [];
  let total = 0;
  for (const [i, line] of allocation.lines.entries()) {
    const text = (amounts[i] ?? "").trim();
    const size = text === "" ? 0 : parseMoneyToMinor(text, currency);
    const name = line.categoryName ?? "Uncategorized";
    if (size === null || size < 0) return { ok: false, message: `Enter an amount for ${name}.` };
    if (size > line.leftMinor) {
      return {
        ok: false,
        message: `${name} has ${formatMinor(line.leftMinor, currency)} left to give back.`,
      };
    }
    total += size;
    if (size > 0) parts.push({ categoryId: line.categoryId, amountMinor: -size });
  }
  if (total !== allocation.refundMinor) {
    const left = allocation.refundMinor - total;
    return {
      ok: false,
      message:
        left > 0
          ? `${formatMinor(left, currency)} of the refund is not in any category yet.`
          : `The amounts add up to ${formatMinor(-left, currency)} more than the refund.`,
    };
  }
  return { ok: true, parts };
}

/**
 * A refund of a split purchase: how much of it goes back to each of the purchase's categories.
 * Each category shows what was spent in it, what other refunds already gave back, and what is
 * left; totals then lower each category's spending by its amount.
 */
export function RefundSplitDialog({
  transaction: t,
  allocation,
  categories,
  onSaved,
  onClose,
}: {
  transaction: Transaction;
  allocation: RefundAllocation;
  categories: Category[];
  onSaved: (updated: Transaction) => void;
  onClose: () => void;
}) {
  const [initial] = useState(() => allocation.lines.map((l) => minorToText(l.thisMinor)));
  const [amounts, setAmounts] = useState<string[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(amounts) !== JSON.stringify(initial);
  const { requestClose, confirm } = useUnsavedGuard(dirty && !busy, onClose);

  const used = amounts.reduce((n, a) => n + (parseMoneyToMinor(a, t.currency) ?? 0), 0);
  const left = allocation.refundMinor - used;
  const colorOf = (id: number | null) => categories.find((c) => c.id === id)?.color ?? "#94a3b8";

  // In proportion to what is left in each category (what the app does by itself).
  const proportional = () => {
    const leftTotal = allocation.lines.reduce((n, l) => n + l.leftMinor, 0);
    const shares = amountsFromPercents(
      allocation.refundMinor,
      allocation.lines.map((l) => (leftTotal > 0 ? (l.leftMinor / leftTotal) * 100 : 0)),
    );
    setAmounts(shares.map(minorToText));
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildRefundSplit(allocation, amounts, t.currency);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Transaction>(`/transactions/${t.id}/splits`, {
        method: "PUT",
        body: JSON.stringify({ parts: built.parts }),
      });
      onSaved(updated);
    } catch (e) {
      setError(errorMessage(e, "Could not save how the refund is divided."));
      setBusy(false);
    }
  }

  const head = "px-2 py-1 text-right font-medium text-slate-500";
  return (
    <Modal title={`Divide ${t.merchant}`} onClose={requestClose} wide dismissible>
      {confirm}
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          {formatMinor(allocation.refundMinor, t.currency)} back from{" "}
          <strong>{t.refundOf?.merchant}</strong>, which was split across categories. Choose how
          much goes back to each one; it lowers that category&apos;s spending in the purchase&apos;s
          month.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full tabular-nums">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left font-medium text-slate-500">Category</th>
                <th className={head}>Spent</th>
                <th className={head}>Refunded before</th>
                <th className={head}>Left</th>
                <th className={head}>This refund</th>
              </tr>
            </thead>
            <tbody>
              {allocation.lines.map((l, i) => {
                const name = l.categoryName ?? "Uncategorized";
                return (
                  <tr
                    key={String(l.categoryId)}
                    className="border-t border-slate-100 dark:border-slate-700"
                  >
                    <td className="px-2 py-1">
                      <span
                        aria-hidden="true"
                        className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: colorOf(l.categoryId) }}
                      />
                      {name}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {formatMinor(l.spentMinor, t.currency)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {formatMinor(l.refundedElsewhereMinor, t.currency)}
                    </td>
                    <td className="px-2 py-1 text-right">{formatMinor(l.leftMinor, t.currency)}</td>
                    <td className="w-32 px-2 py-1">
                      <input
                        aria-label={`Amount back to ${name}`}
                        inputMode="decimal"
                        value={amounts[i] ?? ""}
                        placeholder="0.00"
                        onChange={(e) =>
                          setAmounts((a) => a.map((x, j) => (j === i ? e.target.value : x)))
                        }
                        className={`${inputClass} text-right`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className={buttonClass} onClick={proportional}>
            In proportion
          </button>
          <span
            className={`tabular-nums ${left === 0 ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}
          >
            {left === 0
              ? "Adds up"
              : left > 0
                ? `${formatMinor(left, t.currency)} left`
                : `${formatMinor(-left, t.currency)} over`}
          </span>
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={requestClose}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
