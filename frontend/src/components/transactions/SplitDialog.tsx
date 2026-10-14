import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { categoryOptions } from "../../hooks/useCategories";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import type { Category, RefundAllocation, Transaction } from "../../types/api";
import { CategorySelect } from "../common/CategorySelect";
import { Modal } from "../common/Modal";
import { useUnsavedGuard } from "../common/useUnsavedGuard";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { RefundSplitDialog } from "./RefundSplitDialog";

interface Part {
  categoryId: string;
  amount: string;
  note: string;
}

/** The note the app puts on the reimbursed part of a purchase split by what was kept. */
export const REIMBURSED_NOTE = "Reimbursed";

/** The size of a transaction, as people read it (always positive), in cents. */
const sizeOf = (t: Transaction): number => Math.abs(t.amountMinor);

/** `total` cents in `n` parts as equal as cents allow; the first parts take the odd cents. */
export function splitEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
}

/**
 * `total` cents by percentages. When they add up to 100, the cents add up to the total exactly
 * (each part rounds down, and the leftover cents go to the parts that lost the most); otherwise
 * each part is its share, rounded. A blank or unreadable percentage counts as 0.
 */
export function amountsFromPercents(total: number, percents: number[]): number[] {
  const p = percents.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = p.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1e-9) return p.map((x) => Math.round((total * x) / 100));
  const exact = p.map((x) => (total * x) / 100);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

const minorToText = (minor: number): string => (minor / 100).toFixed(2);
/** A share as a short percentage: "33.3%". */
const percentOf = (part: number, total: number): string =>
  total > 0 ? `${Math.round((part / total) * 1000) / 10}%` : "";

/** The parts as a request, or a message saying what is wrong. Pure, so it can be tested. */
export function buildSplit(
  parts: Part[],
  amountMinor: number,
  /** Fewest parts allowed: 1 when a reimbursed part is set aside as well. */
  minParts = 2,
):
  | {
      ok: true;
      parts: Array<{ categoryId: number | null; amountMinor: number; note: string | null }>;
    }
  | { ok: false; message: string } {
  if (parts.length < minParts) {
    return {
      ok: false,
      message: minParts > 1 ? "Split it into at least two parts." : "Add at least one part.",
    };
  }
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

type SplitDialogProps = {
  transaction: Transaction;
  categories: Category[];
  onSaved: (updated: Transaction) => void;
  onClose: () => void;
};

/**
 * Splits a transaction across categories; a refund of a split purchase is instead divided across
 * that purchase's categories (RefundSplitDialog).
 */
export function SplitDialog(props: SplitDialogProps) {
  const t = props.transaction;
  const allocation = useApi<RefundAllocation | null>(
    t.refundOf ? `/transactions/${t.id}/refund-allocation` : null,
  );
  if (t.refundOf && allocation.loading) {
    return (
      <Modal title={`Split ${t.merchant}`} onClose={props.onClose} dismissible>
        <p className="text-sm text-slate-500">Loading...</p>
      </Modal>
    );
  }
  if (t.refundOf && allocation.data) {
    return <RefundSplitDialog {...props} allocation={allocation.data} />;
  }
  return <CategorySplitDialog {...props} />;
}

/**
 * Divides one transaction across categories. Each part has a category, an amount, and an optional
 * note; the parts must add up to the transaction. Totals and budgets then count each part in its
 * own category; the bank's record of the transaction does not change.
 */
function CategorySplitDialog({ transaction: t, categories, onSaved, onClose }: SplitDialogProps) {
  const id = useId();
  const options = categoryOptions(categories.filter((c) => c.active));
  // A purchase with reimbursements linked is split by what was kept; the app sets the reimbursed
  // part aside on its own (and shows it here only as a note).
  const reimbursed = t.amountMinor > 0 ? Math.min(t.refundedMinor, t.amountMinor - 1) : 0;
  const target = t.amountMinor - reimbursed;
  const ownSplits = t.splits.filter((s) => !(reimbursed > 0 && s.note === REIMBURSED_NOTE));
  const [initial] = useState<Part[]>(() =>
    ownSplits.length > 0
      ? ownSplits.map((s) => ({
          categoryId: s.categoryId === null ? "" : String(s.categoryId),
          amount: (Math.abs(s.amountMinor) / 100).toFixed(2),
          note: s.note ?? "",
        }))
      : [
          {
            categoryId: t.category ? String(t.category.id) : "",
            amount: (Math.abs(target) / 100).toFixed(2),
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

  const total = Math.abs(target);
  const amountOf = (p: Part): number => parseMoneyToMinor(p.amount, "USD") ?? 0;
  const used = parts.reduce((n, p) => n + amountOf(p), 0);
  const left = total - used;
  const set = (i: number, change: Partial<Part>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...change } : p)));

  // Entering each part's share as a percentage instead of an amount: the amounts follow.
  const [mode, setMode] = useState<"amount" | "percent">("amount");
  const [percents, setPercents] = useState<string[]>([]);
  const percentsFromAmounts = (ps: Part[]) =>
    ps.map((p) => (total > 0 ? String(Math.round((amountOf(p) / total) * 10000) / 100) : ""));
  const applyPercents = (next: string[]) => {
    setPercents(next);
    const amounts = amountsFromPercents(
      total,
      next.map((x) => Number(x)),
    );
    setParts((ps) => ps.map((p, i) => ({ ...p, amount: minorToText(amounts[i] ?? 0) })));
  };
  const switchMode = (next: "amount" | "percent") => {
    if (next === "percent") setPercents(percentsFromAmounts(parts));
    setMode(next);
  };
  const splitEven = () => {
    const amounts = splitEvenly(total, parts.length);
    const next = parts.map((p, i) => ({ ...p, amount: minorToText(amounts[i]!) }));
    setParts(next);
    setPercents(percentsFromAmounts(next));
  };
  const addPart = () => {
    setParts((ps) => [
      ...ps,
      { categoryId: "", amount: left > 0 ? minorToText(left) : "", note: "" },
    ]);
    setPercents((pc) => [
      ...pc,
      left > 0 && total > 0 ? String(Math.round((left / total) * 10000) / 100) : "",
    ]);
  };
  const removePart = (i: number) => {
    setParts((ps) => ps.filter((_, j) => j !== i));
    setPercents((pc) => pc.filter((_, j) => j !== i));
  };
  const percentTotal = percents.reduce((n, x) => n + (Number(x) || 0), 0);
  const colorOf = (categoryId: string) =>
    categories.find((c) => String(c.id) === categoryId)?.color ?? "#94a3b8";

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
    // With a reimbursed part set aside, one part of your own is enough.
    const built = buildSplit(parts, target, reimbursed > 0 ? 1 : 2);
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
          {formatMinor(total, t.currency)} across categories. Totals and budgets count each part in
          its own category.
        </p>
        {reimbursed > 0 && (
          <p className="rounded-md bg-blue-50 px-3 py-2 text-blue-900 dark:bg-blue-950 dark:text-blue-200">
            {formatMinor(reimbursed, t.currency)} of the {formatMinor(sizeOf(t), t.currency)} was
            reimbursed, so only what you kept is split. The reimbursed part is set aside on its own
            and doesn&apos;t count as your spending.
          </p>
        )}
        {!t.splitValid && t.splits.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The amount changed since this was split, so it counts whole until the parts add up
            again.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="radiogroup"
            aria-label="Enter each part as"
            className="inline-flex overflow-hidden rounded-md border border-slate-300 text-xs dark:border-slate-600"
          >
            {(["amount", "percent"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => switchMode(m)}
                className={`px-3 py-1.5 ${mode === m ? "bg-blue-600 text-white" : "hover:bg-slate-50 dark:hover:bg-slate-800"}`}
              >
                {m === "amount" ? "Dollars" : "Percent"}
              </button>
            ))}
          </div>
          <button type="button" className={buttonClass} onClick={splitEven}>
            Split evenly
          </button>
        </div>
        {/* Each category's share of the transaction. */}
        <div
          aria-hidden="true"
          className="flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700"
        >
          {parts.map((p, i) => (
            <span
              key={i}
              title={options.find((o) => String(o.id) === p.categoryId)?.name ?? "Uncategorized"}
              style={{
                width: `${total > 0 ? Math.max(0, (amountOf(p) / total) * 100) : 0}%`,
                backgroundColor: colorOf(p.categoryId),
              }}
              className="h-full border-r border-white/60 last:border-r-0 dark:border-slate-800/60"
            />
          ))}
        </div>
        <ul className="space-y-2">
          {parts.map((p, i) => (
            <li
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_7rem_4rem_minmax(0,1fr)_auto] items-center gap-2"
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
                  <option key={o.id} value={o.id} data-depth={o.depth}>
                    {o.label}
                  </option>
                ))}
              </CategorySelect>
              {mode === "amount" ? (
                <input
                  aria-label={`Amount of part ${i + 1}`}
                  inputMode="decimal"
                  value={p.amount}
                  placeholder="0.00"
                  onChange={(e) => set(i, { amount: e.target.value })}
                  className={`${inputClass} text-right`}
                />
              ) : (
                <span className="relative">
                  <input
                    aria-label={`Percent of part ${i + 1}`}
                    inputMode="decimal"
                    value={percents[i] ?? ""}
                    placeholder="0"
                    onChange={(e) =>
                      applyPercents(percents.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    className={`${inputClass} pr-6 text-right`}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-slate-400">
                    %
                  </span>
                </span>
              )}
              {/* The other way of reading the same part. */}
              <span className="text-right text-xs text-slate-500 tabular-nums">
                {mode === "amount"
                  ? percentOf(amountOf(p), total)
                  : formatMinor(amountOf(p), t.currency)}
              </span>
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
                disabled={parts.length <= (reimbursed > 0 ? 1 : 2)}
                onClick={() => removePart(i)}
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
              onClick={addPart}
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
                  const updated = parts.map((p, j) =>
                    j === parts.length - 1 ? { ...p, amount: minorToText(next) } : p,
                  );
                  setParts(updated);
                  setPercents(percentsFromAmounts(updated));
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
            {mode === "percent" && Math.abs(percentTotal - 100) > 1e-9
              ? ` · percentages add up to ${Math.round(percentTotal * 100) / 100}%`
              : ""}
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
