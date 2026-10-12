import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { categoryOptions } from "../../hooks/useCategories";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import { today } from "../../lib/period";
import type { Account, Category } from "../../types/api";
import { Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { Select } from "../common/Select";

/** The subtype of a store credit (gift card) account. */
export const STORE_CREDIT_SUBTYPE = "store credit";
export const isStoreCredit = (a: Pick<Account, "subtype" | "isManual">): boolean =>
  a.isManual && a.subtype === STORE_CREDIT_SUBTYPE;

function Footer({ busy, label, onClose }: { busy: boolean; label: string; onClose: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className={primaryClass} disabled={busy}>
        {busy ? "Saving..." : label}
      </button>
    </div>
  );
}

/** Adds credits: a reload, a gift card received, a reward. Not income or spending. */
export function AddCreditsDialog({
  account,
  onSaved,
  onClose,
}: {
  account: Account;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const amountMinor = parseMoneyToMinor(amount, "USD");
    if (amountMinor === null) {
      setError("Enter the credits added, such as 25.00.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/accounts/${account.id}/credits/add`, {
        method: "POST",
        body: JSON.stringify({ date, amountMinor, description: description.trim() || null }),
      });
      onSaved(`${formatMinor(amountMinor, "USD")} of credit added to ${account.name}.`);
    } catch (e) {
      setError(errorMessage(e, "Could not add the credits."));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Add credits to ${account.name}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-amount`} className="block font-medium">
              Credits added
            </label>
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              autoFocus
              value={amount}
              placeholder="25.00"
              onChange={(e) => setAmount(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-date`} className="block font-medium">
              Date
            </label>
            <input
              id={`${id}-date`}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-desc`} className="block font-medium">
            Where they came from (optional)
          </label>
          <input
            id={`${id}-desc`}
            value={description}
            maxLength={200}
            placeholder="Reload, gift from Sam, reward..."
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </div>
        <p className="text-xs text-slate-500">
          Credits only count in this account: never as income, spending, or net worth. If you bought
          them, that purchase is the spending, on the account that paid.
        </p>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <Footer busy={busy} label="Add credits" onClose={onClose} />
      </form>
    </Modal>
  );
}

/** A purchase paid with the credits, alone or with real money for the rest. */
export function UseCreditsDialog({
  account,
  accounts,
  categories,
  onSaved,
  onClose,
}: {
  account: Account;
  /** Accounts kept by hand that could pay the rest. */
  accounts: Account[];
  categories: Category[];
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const left = account.currentBalanceMinor ?? 0;
  const [date, setDate] = useState(today());
  const [merchant, setMerchant] = useState(account.name);
  const [total, setTotal] = useState("");
  const [credit, setCredit] = useState("");
  const [restFrom, setRestFrom] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totalMinor = parseMoneyToMinor(total, "USD");
  // With nothing typed, the credits pay as much as they can.
  const creditMinor =
    credit.trim() === ""
      ? totalMinor === null
        ? null
        : Math.min(totalMinor, Math.max(0, left))
      : parseMoneyToMinor(credit, "USD");
  const restMinor =
    totalMinor !== null && creditMinor !== null ? Math.max(0, totalMinor - creditMinor) : 0;
  const others = accounts.filter((a) => a.id !== account.id);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (totalMinor === null) {
      setError("Enter the whole price, such as 6.50.");
      return;
    }
    if (creditMinor === null || creditMinor <= 0) {
      setError(
        left > 0 ? "Enter how much the credits paid." : `${account.name} has no credit left.`,
      );
      return;
    }
    if (creditMinor > totalMinor) {
      setError("The credits used cannot be more than the whole price.");
      return;
    }
    if (creditMinor > left) {
      setError(`${account.name} has only ${formatMinor(left, "USD")} of credit left.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/accounts/${account.id}/credits/use`, {
        method: "POST",
        body: JSON.stringify({
          date,
          merchant: merchant.trim() || null,
          totalMinor,
          creditMinor,
          categoryId: categoryId === "" ? null : Number(categoryId),
          restAccountId: restMinor > 0 && restFrom !== "" ? Number(restFrom) : null,
        }),
      });
      onSaved(
        restMinor > 0
          ? `Recorded: ${formatMinor(creditMinor, "USD")} from credits and ${formatMinor(restMinor, "USD")} paid otherwise.`
          : `Recorded: ${formatMinor(creditMinor, "USD")} paid with credits.`,
      );
    } catch (e) {
      setError(errorMessage(e, "Could not record the purchase."));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Use ${account.name} credits`} onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          {formatMinor(left, "USD")} of credit left. The part paid with credits only counts in this
          account; a part paid with real money counts as spending as usual.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-merchant`} className="block font-medium">
              Where
            </label>
            <input
              id={`${id}-merchant`}
              value={merchant}
              maxLength={200}
              onChange={(e) => setMerchant(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-date`} className="block font-medium">
              Date
            </label>
            <input
              id={`${id}-date`}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-total`} className="block font-medium">
              Whole price
            </label>
            <input
              id={`${id}-total`}
              inputMode="decimal"
              autoFocus
              value={total}
              placeholder="6.50"
              onChange={(e) => setTotal(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-credit`} className="block font-medium">
              Paid with credits
            </label>
            <input
              id={`${id}-credit`}
              inputMode="decimal"
              value={credit}
              placeholder={
                creditMinor !== null ? (creditMinor / 100).toFixed(2) : "as much as is left"
              }
              onChange={(e) => setCredit(e.target.value)}
              className={inputClass}
            />
          </div>
          {restMinor > 0 && (
            <div className="sm:col-span-2">
              <label htmlFor={`${id}-rest`} className="block font-medium">
                The other {formatMinor(restMinor, "USD")} was paid from
              </label>
              <Select
                id={`${id}-rest`}
                value={restFrom}
                onChange={(e) => setRestFrom(e.target.value)}
                className={inputClass}
              >
                <option value="">A connected account or card (the bank records it)</option>
                {others.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                Choose an account you keep by hand (such as Cash) to add that part there too. A
                connected card&apos;s part comes in with its next sync, so it is not added twice.
              </p>
            </div>
          )}
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-category`} className="block font-medium">
              Category (optional)
            </label>
            <Select
              id={`${id}-category`}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={inputClass}
            >
              <option value="">Let the rules decide</option>
              {categoryOptions(categories).map((c) => (
                <option key={c.id} value={c.id} data-depth={c.depth}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <Footer busy={busy} label="Record purchase" onClose={onClose} />
      </form>
    </Modal>
  );
}
