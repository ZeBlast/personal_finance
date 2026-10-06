import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { today } from "../../lib/period";
import { Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "./styles";
import {
  buildTransactionPayload,
  TRANSACTION_TYPES,
  type TransactionDraft,
} from "./transactionDraft";

/** Adds one transaction (a contribution, a purchase, a dividend, ...) to a manual account. */
export function TransactionForm({
  accountId,
  accountName,
  onSaved,
  onCancel,
}: {
  accountId: number;
  accountName: string;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<TransactionDraft>({
    date: today(),
    type: "contribution",
    fund: "",
    quantity: "",
    price: "",
    amount: "",
    fees: "",
    description: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<TransactionDraft>): void => setDraft((d) => ({ ...d, ...change }));
  const signedByUser = draft.type === "transfer" || draft.type === "other";

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildTransactionPayload(draft);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/investments/accounts/${accountId}/transactions`, {
        method: "POST",
        body: JSON.stringify(built.payload),
      });
      onSaved(`Added the transaction to ${accountName}.`);
    } catch (e) {
      setError(errorMessage(e, "Could not save the transaction."));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Add a transaction to ${accountName}`} onClose={onCancel} wide>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-date`} className="block font-medium">
              Date
            </label>
            <input
              id={`${id}-date`}
              type="date"
              value={draft.date}
              onChange={(e) => set({ date: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-type`} className="block font-medium">
              Type
            </label>
            <select
              id={`${id}-type`}
              value={draft.type}
              onChange={(e) => set({ type: e.target.value })}
              className={inputClass}
            >
              {TRANSACTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-fund`} className="block font-medium">
              Fund (optional)
            </label>
            <input
              id={`${id}-fund`}
              value={draft.fund}
              maxLength={120}
              onChange={(e) => set({ fund: e.target.value })}
              placeholder="TSP-C, G Fund, or a ticker"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-amount`} className="block font-medium">
              Amount
            </label>
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              value={draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
              placeholder="500.00"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-500">
              {signedByUser
                ? "Use a minus sign for money going out."
                : "A positive number; the type says which way the money moves."}
            </p>
          </div>
          <div>
            <label htmlFor={`${id}-fees`} className="block font-medium">
              Fees (optional)
            </label>
            <input
              id={`${id}-fees`}
              inputMode="decimal"
              value={draft.fees}
              onChange={(e) => set({ fees: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-qty`} className="block font-medium">
              Shares (optional)
            </label>
            <input
              id={`${id}-qty`}
              inputMode="decimal"
              value={draft.quantity}
              onChange={(e) => set({ quantity: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-price`} className="block font-medium">
              Price per share (optional)
            </label>
            <input
              id={`${id}-price`}
              inputMode="decimal"
              value={draft.price}
              onChange={(e) => set({ price: e.target.value })}
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-desc`} className="block font-medium">
              Description (optional)
            </label>
            <input
              id={`${id}-desc`}
              value={draft.description}
              maxLength={200}
              onChange={(e) => set({ description: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Transactions are a record of activity. They do not change the holdings: update those with
          “Edit holdings”.
        </p>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={primaryClass}>
            {busy ? "Saving..." : "Add transaction"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
