import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { categoryOptions } from "../../hooks/useCategories";
import { today } from "../../lib/period";
import type { Account, Category, Transaction } from "../../types/api";
import { ConfirmDialog, Modal } from "../common/Modal";
import { useUnsavedGuard } from "../common/useUnsavedGuard";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import {
  buildManualPayload,
  draftFromTransaction,
  emptyManualDraft,
  REPEAT_OPTIONS,
  type ManualDraft,
} from "./manualTransaction";
import { CategorySelect } from "../common/CategorySelect";
import { announceDataChanged } from "../../lib/syncEvents";
import { MerchantGroupField } from "./MerchantGroupField";
import { RefundLink } from "./RefundLink";
import { Select } from "../common/Select";

/**
 * Adds a transaction by hand to an account the user keeps by hand (cash, for example), or edits
 * one entered earlier. Every field can be filled in; only the account, date, amount, direction and
 * who it was with are required.
 */
export function ManualTransactionDialog({
  accounts,
  categories,
  transaction,
  defaultAccountId,
  defaultDate,
  onSaved,
  onClose,
  onSplit,
}: {
  /** Accounts that accept hand-entered transactions. */
  accounts: Account[];
  categories: Category[];
  /** Set to edit this transaction instead of adding a new one. */
  transaction?: Transaction | undefined;
  defaultAccountId?: number | undefined;
  /** The date a new transaction starts with (today when not given). */
  defaultDate?: string | undefined;
  onSaved: (message: string) => void;
  onClose: () => void;
  /** Offered when set (editing): closes this and opens the split editor. */
  onSplit?: (() => void) | undefined;
}) {
  const id = useId();
  const editing = transaction !== undefined;
  /** The saved transaction as the refund link last left it (refund links apply at once). */
  const [refundView, setRefundView] = useState<Transaction | undefined>(transaction);
  // What the form started with, to tell whether anything was changed.
  const [initial] = useState<ManualDraft>(() =>
    transaction
      ? draftFromTransaction(transaction)
      : emptyManualDraft(
          defaultDate ?? today(),
          String(defaultAccountId ?? (accounts.length === 1 ? accounts[0]!.id : "")),
        ),
  );
  const [draft, setDraft] = useState<ManualDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (change: Partial<ManualDraft>): void => setDraft((d) => ({ ...d, ...change }));
  const options = categoryOptions(categories);
  const out = draft.direction === "out";
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const { requestClose, confirm } = useUnsavedGuard(dirty && !busy, onClose);
  // Escape or a click outside while the delete question is up only closes that question.
  const close = () => (confirmDelete ? setConfirmDelete(false) : requestClose());

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildManualPayload(draft, editing ? "edit" : "create", transaction?.isTransfer);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api(`/transactions/${transaction.id}`, {
          method: "PATCH",
          body: JSON.stringify(built.payload),
        });
        onSaved("Transaction updated.");
      } else {
        await api("/transactions", { method: "POST", body: JSON.stringify(built.payload) });
        onSaved("Transaction added.");
      }
    } catch (e) {
      setError(errorMessage(e, "Could not save the transaction."));
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!transaction) return;
    setBusy(true);
    try {
      await api(`/transactions/${transaction.id}`, { method: "DELETE" });
      onSaved("Transaction deleted.");
    } catch (e) {
      setError(errorMessage(e, "Could not delete the transaction."));
      setConfirmDelete(false);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? "Edit transaction" : "Add a transaction"}
      onClose={close}
      wide
      dismissible
    >
      {confirm}
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-account`} className="block font-medium">
              Account
            </label>
            <Select
              id={`${id}-account`}
              value={draft.accountId}
              onChange={(e) => set({ accountId: e.target.value })}
              className={inputClass}
            >
              <option value="">Choose an account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
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
        </div>

        <fieldset>
          <legend className="font-medium">Which way did the money move?</legend>
          <div className="mt-1 flex gap-4">
            {(
              [
                ["out", "Money out (spent or paid)"],
                ["in", "Money in (received)"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-direction`}
                  value={value}
                  checked={draft.direction === value}
                  onChange={() => set({ direction: value })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-amount`} className="block font-medium">
              Amount
            </label>
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              value={draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
              placeholder="12.50"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-merchant`} className="block font-medium">
              {out ? "Paid to (merchant)" : "From (merchant or source)"}
            </label>
            <input
              id={`${id}-merchant`}
              value={draft.merchant}
              maxLength={200}
              onChange={(e) => set({ merchant: e.target.value })}
              className={inputClass}
            />
            {transaction && (
              // The saved merchant's group (a new one has no merchant to group yet).
              <div className="mt-2">
                <MerchantGroupField
                  merchant={transaction.merchantOriginal}
                  group={transaction.merchantGroup}
                  onChanged={announceDataChanged}
                />
              </div>
            )}
            {refundView && (
              <div className="mt-2">
                <RefundLink
                  transaction={refundView}
                  onChanged={(updated) => {
                    setRefundView(updated);
                    announceDataChanged();
                  }}
                />
              </div>
            )}
          </div>
          <div>
            <label htmlFor={`${id}-category`} className="block font-medium">
              Category
            </label>
            <CategorySelect
              shown={
                options.find((o) => String(o.id) === draft.categoryId)?.name ??
                "Uncategorized (let the rules decide)"
              }
              id={`${id}-category`}
              value={draft.categoryId}
              onChange={(e) => set({ categoryId: e.target.value })}
              className={inputClass}
            >
              <option value="">Uncategorized (let the rules decide)</option>
              {options.map((o) => (
                <option key={o.id} value={o.id} data-depth={o.depth}>
                  {o.label}
                </option>
              ))}
            </CategorySelect>
            {onSplit && transaction && (
              <button
                type="button"
                className="mt-1 text-xs text-blue-700 underline dark:text-blue-400"
                onClick={() =>
                  dirty ? setError("Save or cancel your changes first, then split it.") : onSplit()
                }
              >
                {transaction.splits.length > 0
                  ? "Change the split..."
                  : "Split across categories..."}
              </button>
            )}
          </div>
          <div>
            <label htmlFor={`${id}-person`} className="block font-medium">
              {out ? "Recipient (optional)" : "Sender (optional)"}
            </label>
            <input
              id={`${id}-person`}
              value={draft.person}
              maxLength={100}
              onChange={(e) => set({ person: e.target.value })}
              placeholder={out ? "Who was it paid to?" : "Who sent you this money?"}
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-description`} className="block font-medium">
              Description (optional)
            </label>
            <input
              id={`${id}-description`}
              value={draft.description}
              maxLength={200}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Defaults to the merchant"
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-notes`} className="block font-medium">
              Notes (optional)
            </label>
            <textarea
              id={`${id}-notes`}
              value={draft.notes}
              rows={2}
              maxLength={2000}
              onChange={(e) => set({ notes: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>

        {!editing && (
          <div>
            <label htmlFor={`${id}-repeat`} className="block font-medium">
              Repeat
            </label>
            <Select
              id={`${id}-repeat`}
              value={draft.repeat}
              onChange={(e) => set({ repeat: e.target.value as ManualDraft["repeat"] })}
              className={inputClass}
            >
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {draft.repeat && (
              <p className="mt-1 text-xs text-slate-500">
                This one is recorded now. The next ones show up on the calendar as expected, and you
                can record or skip each when it comes.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.isTransfer}
              onChange={(e) => set({ isTransfer: e.target.checked })}
            />
            A transfer between my own accounts (not income or spending)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.pending}
              onChange={(e) => set({ pending: e.target.checked })}
            />
            Still pending
          </label>
        </div>

        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <div>
            {editing && (
              <button
                type="button"
                className={`${buttonClass} text-red-700 dark:text-red-400`}
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={requestClose}>
              Cancel
            </button>
            <button type="submit" className={primaryClass} disabled={busy}>
              {busy ? "Saving..." : editing ? "Save" : "Add transaction"}
            </button>
          </div>
        </div>
      </form>
      {confirmDelete && transaction && (
        <ConfirmDialog
          title="Delete this transaction?"
          message={`${transaction.merchant} will be removed and the account balance will be recalculated.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  );
}
