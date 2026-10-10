import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { categoryOptions } from "../../hooks/useCategories";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import type { Category, Transaction } from "../../types/api";
import { CategorySelect } from "../common/CategorySelect";
import { Modal } from "../common/Modal";
import { useUnsavedGuard } from "../common/useUnsavedGuard";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";

interface Part {
  categoryId: string;
  amount: string;
  note: string;
}

/** The size of a transaction, as people read it (always positive), in cents. */
const sizeOf = (t: Transaction): number => Math.abs(t.amountMinor);

/** The parts as a request, or a message saying what is wrong. Pure, so it can be tested. */
export function buildSplit(
  parts: Part[],
  amountMinor: number,
):
  | {
      ok: true;
      parts: Array<{ categoryId: number | null; amountMinor: number; note: string | null }>;
    }
  | { ok: false; message: string } {
  if (parts.length < 2) return { ok: false, message: "Split it into at least two parts." };
  const sign = amountMinor < 0 ? -1 : 1;
  const out = [];
  for (const [i, p] of parts.entries()) {
    const size = parseMoneyToMinor(p.amount, "USD");
    if (size === null || size <= 0) {
      return { ok: false, message: `Enter an amount for part ${i + 1}, such as 12.50.` };
    }
    out.push({
      categoryId: p.categoryId === "" ? null : Number(p.categoryId),
      amountMinor: size * sign,
      note: p.note.trim() || null,
    });
  }
  const total = out.reduce((n, p) => n + p.amountMinor, 0);
  if (total !== amountMinor) {
    const left = Math.abs(amountMinor) - Math.abs(total);
    return {
      ok: false,
      message:
        left > 0
          ? `${formatMinor(left, "USD")} is not in any part yet.`
          : `The parts add up to ${formatMinor(-left, "USD")} more than the transaction.`,
    };
  }
  return { ok: true, parts: out };
}

/**
 * Divides one transaction across categories. Each part has a category, an amount, and an optional
 * note; the parts must add up to the transaction. Totals and budgets then count each part in its
 * own category; the bank's record of the transaction does not change.
 */
export function SplitDialog({
  transaction: t,
  categories,
  onSaved,
  onClose,
}: {
  transaction: Transaction;
  categories: Category[];
  onSaved: (updated: Transaction) => void;
  onClose: () => void;
}) {
  const id = useId();
  const options = categoryOptions(categories.filter((c) => c.active));
  const [initial] = useState<Part[]>(() =>
    t.splits.length > 0
      ? t.splits.map((s) => ({
          categoryId: s.categoryId === null ? "" : String(s.categoryId),
          amount: (Math.abs(s.amountMinor) / 100).toFixed(2),
          note: s.note ?? "",
        }))
      : [
          {
            categoryId: t.category ? String(t.category.id) : "",
            amount: (sizeOf(t) / 100).toFixed(2),
            note: "",
          },
          { categoryId: "", amount: "", note: "" },
        ],
  );
  const [parts, setParts] = useState<Part[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(parts) !== JSON.stringify(initial);
  const { requestClose, confirm } = useUnsavedGuard(dirty && !busy, onClose);

  const used = parts.reduce((n, p) => n + (parseMoneyToMinor(p.amount, "USD") ?? 0), 0);
  const left = sizeOf(t) - used;
  const set = (i: number, change: Partial<Part>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...change } : p)));

  async function save(body: { parts: unknown[] }): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Transaction>(`/transactions/${t.id}/splits`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      onSaved(updated);
    } catch (e) {
      setError(errorMessage(e, "Could not save the split."));
      setBusy(false);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildSplit(parts, t.amountMinor);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    await save({ parts: built.parts });
  }

  return (
    <Modal title={`Split ${t.merchant}`} onClose={requestClose} wide dismissible>
      {confirm}
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          {formatMinor(sizeOf(t), t.currency)} across categories. Totals and budgets count each part
          in its own category.
        </p>
        {!t.splitValid && t.splits.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The amount changed since this was split, so it counts whole until the parts add up
            again.
          </p>
        )}
        <ul className="space-y-2">
          {parts.map((p, i) => (
            <li
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto] items-center gap-2"
            >
              <CategorySelect
                shown={options.find((o) => String(o.id) === p.categoryId)?.name ?? "Uncategorized"}
                aria-label={`Category of part ${i + 1}`}
                value={p.categoryId}
                onChange={(e) => set(i, { categoryId: e.target.value })}
                className={inputClass}
              >
                <option value="">Uncategorized</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </CategorySelect>
              <input
                aria-label={`Amount of part ${i + 1}`}
                inputMode="decimal"
                value={p.amount}
                placeholder="0.00"
                onChange={(e) => set(i, { amount: e.target.value })}
                className={`${inputClass} text-right`}
              />
              <input
                aria-label={`Note for part ${i + 1}`}
                value={p.note}
                maxLength={200}
                placeholder="Note (optional)"
                onChange={(e) => set(i, { note: e.target.value })}
                className={inputClass}
              />
              <button
                type="button"
                aria-label={`Remove part ${i + 1}`}
                disabled={parts.length <= 2}
                onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                className="px-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={parts.length >= 20}
              onClick={() =>
                setParts((ps) => [
                  ...ps,
                  { categoryId: "", amount: left > 0 ? (left / 100).toFixed(2) : "", note: "" },
                ])
              }
            >
              + Add a part
            </button>
            {left !== 0 && (
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  // Put what is left (or take what is over) on the last part.
                  const lastAmount = parseMoneyToMinor(parts.at(-1)!.amount, "USD") ?? 0;
                  const next = Math.max(0, lastAmount + left);
                  set(parts.length - 1, { amount: (next / 100).toFixed(2) });
                }}
              >
                Put the rest in the last part
              </button>
            )}
          </div>
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
          <p role="alert" id={`${id}-error`} className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            {t.splits.length > 0 && (
              <button
                type="button"
                className={`${buttonClass} text-red-700 dark:text-red-400`}
                disabled={busy}
                onClick={() => void save({ parts: [] })}
              >
                Remove the split
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={requestClose}>
              Cancel
            </button>
            <button type="submit" className={primaryClass} disabled={busy}>
              {busy ? "Saving..." : "Save split"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
