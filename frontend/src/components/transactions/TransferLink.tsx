import { useId, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Account, Transaction } from "../../types/api";

const STORE_CREDIT_SUBTYPE = "store credit";

/** Accounts kept by hand that hold ordinary transactions (cash, checking, savings, a card). */
const linkable = (a: Account, from: number) =>
  a.isManual &&
  !a.hidden &&
  a.id !== from &&
  (a.type === "depository" || a.type === "credit") &&
  a.subtype !== STORE_CREDIT_SUBTYPE;

interface Candidate {
  transaction: Transaction;
  /** The amount is exactly the opposite of this transfer's. */
  exactAmount: boolean;
  daysApart: number;
}

const buttonClass = "rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600";

/**
 * The other side of a transfer: where the money went, or where it came from. A pair the app
 * matched, or one made by hand, can be changed to another transaction or unlinked; a transfer with
 * no other side can be paired with a transaction on another account (the likeliest are suggested),
 * or linked with an account kept by hand, where the app adds the other side.
 */
export function TransferLink({
  transaction: t,
  transferChosen,
  onChanged,
}: {
  transaction: Transaction;
  /** The transfer choice in the form says yes, even if not saved yet. */
  transferChosen: boolean;
  onChanged: (updated: Transaction) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const out = t.amountMinor > 0; // money left this account

  async function run(path: string, method: "POST" | "DELETE", body?: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Transaction>(`/transactions/${t.id}/${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      setChanging(false);
      onChanged(updated);
    } catch (e) {
      setError(errorMessage(e, "Could not change the other side of this transfer."));
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error && (
    <p role="alert" className="mt-1 basis-full text-red-600">
      {error}
    </p>
  );

  if (t.createdForTransfer && t.transferWith) {
    return (
      <p className="mt-1 text-xs text-slate-500">
        Added when a transfer on {t.transferWith.accountName} (
        {formatDay(t.transferWith.transactionDate)}) was linked with this account. To undo it,
        unlink that transfer, or delete this transaction.
      </p>
    );
  }

  if (t.transferWith) {
    const other = t.transferWith;
    return (
      <div className="mt-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {out ? "Went to" : "Came from"} <strong>{other.accountName}</strong> ({other.merchant},{" "}
            {formatDay(other.transactionDate)})
            {t.transferSource === "auto" ? ", matched by the app" : ""}.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setChanging((v) => !v)}
            className={buttonClass}
          >
            {changing ? "Cancel" : "Change"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("transfer-pair", "DELETE")}
            className={buttonClass}
            title="Keep this as a transfer, without another side, so you can choose the right one"
          >
            {busy ? "Unlinking..." : "Unlink"}
          </button>
          {errorLine}
        </div>
        {changing && (
          <OtherSidePicker
            transaction={t}
            busy={busy}
            onPair={(otherId) => void run("transfer-pair", "POST", { otherId })}
            onLinkAccount={(accountId) => void run("transfer-account", "POST", { accountId })}
            allowAccountLink={false}
          />
        )}
      </div>
    );
  }

  if (!(t.isTransfer || transferChosen)) return null;
  return (
    <div className="mt-2 rounded-md border border-amber-300 p-2 text-sm dark:border-amber-700">
      <p className="font-medium">
        {out ? "Where did the money go?" : "Where did the money come from?"}
      </p>
      <p className="text-xs text-slate-500">
        This transfer isn't paired with the other side on another of your accounts. Choose it below,
        so the money is followed from one account to the other.
      </p>
      <OtherSidePicker
        transaction={t}
        busy={busy}
        onPair={(otherId) => void run("transfer-pair", "POST", { otherId })}
        onLinkAccount={(accountId) => void run("transfer-account", "POST", { accountId })}
        allowAccountLink
      />
      {errorLine}
    </div>
  );
}

/** Suggested transactions for the other side, and (for a one-sided transfer) hand-kept accounts. */
function OtherSidePicker({
  transaction: t,
  busy,
  onPair,
  onLinkAccount,
  allowAccountLink,
}: {
  transaction: Transaction;
  busy: boolean;
  onPair: (otherId: number) => void;
  onLinkAccount: (accountId: number) => void;
  allowAccountLink: boolean;
}) {
  const id = useId();
  const candidates = useApi<Candidate[]>(`/transactions/${t.id}/transfer-candidates`);
  const accounts = useApi<Account[]>(allowAccountLink ? "/accounts" : null);
  const [accountId, setAccountId] = useState<number | "">("");
  const choices = (accounts.data ?? []).filter((a) => linkable(a, t.accountId));
  const current = t.transferWith?.id;
  const list = (candidates.data ?? []).filter((c) => c.transaction.id !== current);

  return (
    <div className="mt-2">
      {candidates.error && <p className="text-red-600">{candidates.error}</p>}
      {candidates.data && list.length === 0 && (
        <p className="text-xs text-slate-500">
          No transaction going the other way within 15 days on your other accounts.
        </p>
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {list.map(({ transaction: c, exactAmount, daysApart }) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-2 py-1">
              <span className="min-w-0 flex-1">
                <strong>{c.accountName}</strong> · {c.merchant} ·{" "}
                {formatDay(c.authorizedDate ?? c.date)}
                <span className="block text-xs text-slate-500">
                  {formatMinor(-c.amountMinor, c.currency)}
                  {exactAmount ? " · same amount" : " · different amount"}
                  {` · ${daysApart} day${daysApart === 1 ? "" : "s"} apart`}
                  {c.transferWith ? ` · now paired with ${c.transferWith.accountName}` : ""}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPair(c.id)}
                className={buttonClass}
              >
                Pair
              </button>
            </li>
          ))}
        </ul>
      )}
      {allowAccountLink && choices.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-account`} className="text-xs text-slate-500">
            Or an account you keep by hand (the app adds the other side there):
          </label>
          <select
            id={`${id}-account`}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value === "" ? "" : Number(e.target.value))}
            className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
          >
            <option value="">Choose an account...</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || accountId === ""}
            onClick={() => accountId !== "" && onLinkAccount(accountId)}
            className={buttonClass}
          >
            Link
          </button>
        </div>
      )}
    </div>
  );
}
