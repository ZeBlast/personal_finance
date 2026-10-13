import { useEffect, useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { currencyDigits, formatMinor, parseMoneyToMinor } from "../../lib/money";
import { announceDataChanged, useSyncFinishedCount } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { Account, CreditLimitEntry, CreditLimitHistory } from "../../types/api";
import { ConfirmDialog, Modal } from "../common/Modal";

const inputClass =
  "mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";
const smallButton =
  "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700";

/** Today as YYYY-MM-DD in the user's own time zone (not UTC). */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** An amount in major units for an edit box ("2500.00"), without currency symbols. */
function editableAmount(minor: number, currency: string): string {
  return (minor / 10 ** currencyDigits(currency)).toFixed(currencyDigits(currency));
}

function LimitForm({
  account,
  entry,
  onSaved,
  onCancel,
}: {
  account: Account;
  entry: CreditLimitEntry | null;
  onSaved: (history: CreditLimitHistory) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [amount, setAmount] = useState(
    entry ? editableAmount(entry.limitMinor, entry.currency) : "",
  );
  const [date, setDate] = useState(entry?.effectiveDate ?? today());
  const [note, setNote] = useState(entry?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const minor = parseMoneyToMinor(amount, account.currency);
    if (minor === null) {
      setError(
        `Enter the limit as a positive amount with at most ${currencyDigits(account.currency)} decimal places, for example 2500.`,
      );
      return;
    }
    if (date === "") {
      setError("Choose the date the limit took effect.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const history = entry
        ? await api<CreditLimitHistory>(`/credit-limits/${entry.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              limitMinor: minor,
              effectiveDate: date,
              note: note.trim() || null,
            }),
          })
        : await api<CreditLimitHistory>(`/accounts/${account.id}/credit-limits`, {
            method: "POST",
            body: JSON.stringify({
              limitMinor: minor,
              effectiveDate: date,
              note: note.trim() || null,
            }),
          });
      onSaved(history);
    } catch (e) {
      setError(errorMessage(e, "Could not save the limit."));
      setBusy(false);
    }
  }

  return (
    <Modal title={entry ? "Edit credit limit entry" : "Add a credit limit"} onClose={onCancel}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <p className="text-slate-500">
          {account.name}. Use this to record a change the bank made, including one from the past.
        </p>
        <div>
          <label htmlFor={`${id}-amount`} className="block font-medium">
            Credit limit ({account.currency})
          </label>
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            value={amount}
            autoFocus
            onChange={(e) => setAmount(e.target.value)}
            placeholder="2500.00"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${id}-date`} className="block font-medium">
            Took effect on
          </label>
          <input
            id={`${id}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            A date in the future is kept as scheduled and becomes the current limit on that day.
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-note`} className="block font-medium">
            Note (optional)
          </label>
          <input
            id={`${id}-note`}
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="for example: requested an increase"
            className={inputClass}
          />
        </div>
        {entry?.source === "plaid" && (
          <p className="text-xs text-slate-500">
            This entry was observed from the bank. Changing the amount makes it your own entry;
            changing only the date or note keeps it as observed.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-600"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A card's credit limit history, with adding, editing and deleting entries by hand. */
export function LimitHistory({
  account,
  defaultOpen = false,
}: {
  account: Account;
  /** Start expanded (in a dialog of its own, say). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<CreditLimitHistory | null>(null);
  const [form, setForm] = useState<CreditLimitEntry | "new" | null>(null);
  const [deleting, setDeleting] = useState<CreditLimitEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const synced = useSyncFinishedCount();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<CreditLimitHistory>(`/accounts/${account.id}/credit-limits`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, account.id, account.creditLimitMinor, synced]);

  /** Show the recalculated history, and let the account row above update its limit too. */
  function accept(history: CreditLimitHistory): void {
    setData(history);
    announceDataChanged();
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setBusy(true);
    try {
      accept(await api<CreditLimitHistory>(`/credit-limits/${deleting.id}`, { method: "DELETE" }));
      setDeleting(null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "Could not delete that entry."));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className={defaultOpen ? "text-sm" : "mt-1 ml-6 text-xs"}
      open={defaultOpen || undefined}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-slate-500">Credit limit history</summary>
      <div className="mt-2 space-y-2">
        {data && data.entries.length === 0 && (
          <p className="text-slate-500">
            No limit recorded yet. One is noted the first time a sync sees it, or you can add one.
          </p>
        )}
        <ul className="space-y-1">
          {data?.entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-600 dark:text-slate-300"
            >
              <span className="w-24">{formatDay(entry.effectiveDate)}</span>
              <span className="w-20 font-medium">
                {formatMinor(entry.limitMinor, entry.currency)}
              </span>
              <span className="w-32">
                {entry.changeMinor === null
                  ? "first recorded"
                  : `${entry.changeMinor > 0 ? "+" : ""}${formatMinor(entry.changeMinor, entry.currency)}${
                      entry.changePercent === null
                        ? ""
                        : ` (${entry.changePercent > 0 ? "+" : ""}${entry.changePercent}%)`
                    }`}
              </span>
              <span className="text-slate-500">
                {entry.source === "plaid" ? "observed from bank" : "entered manually"}
                {entry.note ? ` · ${entry.note}` : ""}
              </span>
              <span className="flex gap-1">
                <button
                  type="button"
                  className={smallButton}
                  aria-label={`Edit limit entry from ${formatDay(entry.effectiveDate)}`}
                  onClick={() => setForm(entry)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`${smallButton} border-red-300 text-red-700 dark:border-red-800 dark:text-red-400`}
                  aria-label={`Delete limit entry from ${formatDay(entry.effectiveDate)}`}
                  onClick={() => setDeleting(entry)}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <button type="button" className={smallButton} onClick={() => setForm("new")}>
          Add a limit
        </button>
      </div>

      {form && (
        <LimitForm
          account={account}
          entry={form === "new" ? null : form}
          onCancel={() => setForm(null)}
          onSaved={(history) => {
            accept(history);
            setForm(null);
            setError(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this limit entry?"
          message={
            <>
              Deletes the {formatMinor(deleting.limitMinor, deleting.currency)} entry from{" "}
              {formatDay(deleting.effectiveDate)}. The current limit and every change figure are
              recalculated.
              {deleting.source === "plaid" &&
                " If the bank still reports that limit, the next sync will note it again."}
            </>
          }
          confirmLabel="Delete entry"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </details>
  );
}
