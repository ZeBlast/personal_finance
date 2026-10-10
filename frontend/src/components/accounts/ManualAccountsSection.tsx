import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { useCategories } from "../../hooks/useCategories";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import type { Account } from "../../types/api";
import { ConfirmDialog, Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { CashbackSection } from "./CashbackSection";
import { HiddenBadge, HideToggle } from "./HideToggle";
import { ManualTransactionDialog } from "../transactions/ManualTransactionDialog";
import { AddCreditsDialog, isStoreCredit, UseCreditsDialog } from "./StoreCreditDialogs";

type Kind = "cash" | "checking" | "savings" | "credit_card" | "store_credit";

const KINDS: Array<{ value: Kind; label: string; balanceLabel: string; help: string }> = [
  {
    value: "cash",
    label: "Cash (wallet, jar, envelope)",
    balanceLabel: "Cash on hand right now",
    help: "Track cash you spend and receive. The balance is worked out from your transactions.",
  },
  {
    value: "checking",
    label: "Checking account",
    balanceLabel: "Current balance",
    help: "For an account at a bank that cannot be connected automatically.",
  },
  {
    value: "savings",
    label: "Savings account",
    balanceLabel: "Current balance",
    help: "For an account at a bank that cannot be connected automatically.",
  },
  {
    value: "credit_card",
    label: "Credit card",
    balanceLabel: "Amount owed right now",
    help: "Purchases raise what you owe; payments lower it.",
  },
  {
    value: "store_credit",
    label: "Gift card / store credit",
    balanceLabel: "Credit on it right now",
    help: "Dollar credits with one business, such as a Dunkin gift card. Add credits, then record purchases paid with them, alone or with real money. Credits only count in this account: never in income, spending, or net worth.",
  },
];

function NewAccountDialog({
  onCreated,
  onClose,
}: {
  onCreated: (message: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("cash");
  const [balance, setBalance] = useState("");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = KINDS.find((k) => k.value === kind)!;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Give the account a name.");
      return;
    }
    const opening =
      balance.trim() === "" ? 0 : parseMoneyToMinor(balance, "USD", { allowZero: true });
    if (opening === null) {
      setError("Enter the starting amount in dollars, for example 250.00, or leave it empty.");
      return;
    }
    const limitMinor = limit.trim() === "" ? undefined : parseMoneyToMinor(limit, "USD");
    if (limit.trim() !== "" && limitMinor === null) {
      setError("Enter the credit limit in dollars, for example 5000.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/accounts/manual", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          kind,
          ...(opening !== 0 ? { openingBalanceMinor: opening } : {}),
          ...(kind === "credit_card" && limitMinor ? { creditLimitMinor: limitMinor } : {}),
        }),
      });
      onCreated(`${name.trim()} was created.`);
    } catch (e) {
      setError(errorMessage(e, "Could not create the account."));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add an account by hand" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div>
          <label htmlFor={`${id}-kind`} className="block font-medium">
            Type
          </label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className={inputClass}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">{info.help}</p>
        </div>
        <div>
          <label htmlFor={`${id}-name`} className="block font-medium">
            Name
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={
              kind === "cash" ? "Wallet" : kind === "store_credit" ? "Dunkin" : "My account"
            }
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${id}-balance`} className="block font-medium">
            {info.balanceLabel} (optional)
          </label>
          <input
            id={`${id}-balance`}
            inputMode="decimal"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            placeholder="0.00"
            className={inputClass}
          />
        </div>
        {kind === "credit_card" && (
          <div>
            <label htmlFor={`${id}-limit`} className="block font-medium">
              Credit limit (optional)
            </label>
            <input
              id={`${id}-limit`}
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className={inputClass}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? "Creating..." : "Create account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Accounts the user keeps by hand (cash, a bank that cannot be connected, a card): their balances,
 * a way to add transactions to them, and to remove them. Investment accounts kept by hand are on
 * the Investments page instead.
 */
export function ManualAccountsSection() {
  const accounts = useApi<Account[]>("/accounts?includeHidden=1");
  const { categories } = useCategories();
  const [dialog, setDialog] = useState<"new" | null>(null);
  const [adding, setAdding] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [credits, setCredits] = useState<{ account: Account; action: "add" | "use" } | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const mine = (accounts.data ?? []).filter((a) => a.isManual && a.type !== "investment");

  function changed(text: string): void {
    setDialog(null);
    setAdding(null);
    setCredits(null);
    setNotice({ kind: "info", text });
    accounts.reload();
    announceDataChanged();
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/accounts/manual/${deleting.id}`, { method: "DELETE" });
      changed(`${deleting.name} was deleted.`);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not delete the account.") });
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Accounts you keep by hand</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Cash, gift cards and store credit, or an account at a bank that cannot be connected. You
            enter the transactions; the balance is worked out from them.
          </p>
        </div>
        <button type="button" className={primaryClass} onClick={() => setDialog("new")}>
          Add account by hand
        </button>
      </div>
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
              : "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
          }`}
        >
          {notice.text}
        </p>
      )}
      {mine.length === 0 ? (
        <p className="text-sm text-slate-500">
          None yet. Add a Cash account to keep track of cash you spend and receive.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {mine.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: a.color ?? "#94a3b8" }}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    {a.hidden && <HiddenBadge />}
                  </div>
                  <div className="text-xs text-slate-500">
                    {a.subtype ?? a.type}
                    {a.type === "credit" ? " · amount owed" : ""}
                    {isStoreCredit(a) ? " · credit left" : ""}
                    {a.creditLimitMinor
                      ? ` · limit ${formatMinor(a.creditLimitMinor, a.currency)}`
                      : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-medium tabular-nums">
                  {formatMinor(a.currentBalanceMinor, a.currency)}
                </span>
                <HideToggle
                  account={a}
                  onChanged={() => accounts.reload()}
                  onError={(text) => setNotice({ kind: "error", text })}
                />
                {isStoreCredit(a) ? (
                  <>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => setCredits({ account: a, action: "add" })}
                    >
                      Add credits
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => setCredits({ account: a, action: "use" })}
                    >
                      Use credits
                    </button>
                  </>
                ) : (
                  <button type="button" className={buttonClass} onClick={() => setAdding(a)}>
                    Add transaction
                  </button>
                )}
                <button
                  type="button"
                  className={`${buttonClass} text-red-700 dark:text-red-400`}
                  aria-label={`Delete ${a.name}`}
                  onClick={() => setDeleting(a)}
                >
                  Delete
                </button>
              </div>
              {a.type === "credit" && (
                <div className="basis-full">
                  <CashbackSection account={a} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {dialog === "new" && <NewAccountDialog onCreated={changed} onClose={() => setDialog(null)} />}
      {adding && (
        <ManualTransactionDialog
          accounts={mine}
          categories={categories ?? []}
          defaultAccountId={adding.id}
          onSaved={changed}
          onClose={() => setAdding(null)}
        />
      )}
      {credits?.action === "add" && (
        <AddCreditsDialog
          account={credits.account}
          onSaved={changed}
          onClose={() => setCredits(null)}
        />
      )}
      {credits?.action === "use" && (
        <UseCreditsDialog
          account={credits.account}
          accounts={mine.filter((a) => !a.hidden)}
          categories={categories ?? []}
          onSaved={changed}
          onClose={() => setCredits(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="The account and all of its transactions will be removed from this app. This cannot be undone."
          confirmLabel="Delete account"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
