import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { categoryOptions, useCategories } from "../../hooks/useCategories";
import type { Account } from "../../types/api";
import type { SubscriptionBilling, SubscriptionFrequency } from "../../types/planning";
import { CategorySelect } from "../common/CategorySelect";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import { buildSubscription, type Draft } from "./subscriptionDraft";

export const BILLING_CHOICES: Array<{ value: SubscriptionBilling; label: string; help: string }> = [
  { value: "recurring", label: "Renews", help: "Charged again and again until you cancel." },
  {
    value: "installments",
    label: "Monthly for a set time",
    help: "Charged every month for a number of months, then it ends.",
  },
  {
    value: "prepaid",
    label: "Paid once for a set time",
    help: "One charge that covers a number of months from the start day.",
  },
];

export function SubscriptionDialog({
  draft,
  onClose,
}: {
  draft: Draft;
  onClose: (saved: boolean) => void;
}) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accounts = useApi<Account[]>("/accounts");
  const { categories } = useCategories();
  const options = categoryOptions((categories ?? []).filter((c) => c.active));
  const set = (change: Partial<Draft>) => setD((x) => ({ ...x, ...change }));

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    const built = buildSubscription(d);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(d.id === null ? "/tracked-subscriptions" : `/tracked-subscriptions/${d.id}`, {
        method: d.id === null ? "POST" : "PUT",
        body: JSON.stringify(built.body),
      });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save the subscription."));
      setBusy(false);
    }
  }

  const label = "block text-sm font-medium";
  return (
    <Modal
      title={
        d.id === null
          ? d.recurringKey
            ? `Track ${d.name}`
            : "Add a subscription"
          : `Edit ${d.name}`
      }
      onClose={() => onClose(false)}
      wide
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Name
            <input
              value={d.name}
              maxLength={120}
              autoFocus
              onChange={(e) => set({ name: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className={label}>
            Cost of each charge
            <input
              value={d.amount}
              inputMode="decimal"
              placeholder="0.00 if free"
              title="Leave it at 0 for a free subscription you only want to keep track of."
              onChange={(e) => set({ amount: e.target.value })}
              className={inputClass}
            />
          </label>
        </div>

        <fieldset className="space-y-1">
          <legend className={label}>How it is billed</legend>
          {BILLING_CHOICES.map((c) => (
            <label key={c.value} className="flex items-start gap-2">
              <input
                type="radio"
                name="billing"
                className="mt-1"
                checked={d.billing === c.value}
                onChange={() => set({ billing: c.value })}
              />
              <span>
                {c.label}
                <span className="block text-xs text-slate-500">{c.help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className={label}>
            {d.billing === "recurring" ? "First charge" : "Starts on"}
            <input
              type="date"
              value={d.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
              className={inputClass}
            />
          </label>
          {d.billing === "recurring" ? (
            <>
              <label className={label}>
                Renews every
                <input
                  value={d.repeatEvery}
                  inputMode="numeric"
                  onChange={(e) => set({ repeatEvery: e.target.value })}
                  className={inputClass}
                />
              </label>
              <label className={label}>
                Period
                <Select
                  value={d.frequency}
                  onChange={(e) => set({ frequency: e.target.value as SubscriptionFrequency })}
                  className={inputClass}
                >
                  <option value="weekly">Week(s)</option>
                  <option value="monthly">Month(s)</option>
                  <option value="yearly">Year(s)</option>
                </Select>
              </label>
            </>
          ) : (
            <label className={label}>
              For how many months
              <input
                value={d.termMonths}
                inputMode="numeric"
                onChange={(e) => set({ termMonths: e.target.value })}
                className={inputClass}
              />
            </label>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Paid from
            <Select
              value={d.accountId}
              onChange={(e) => set({ accountId: e.target.value })}
              className={inputClass}
            >
              <option value="">Not set</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </label>
          <label className={label}>
            Category
            <CategorySelect
              shown={options.find((o) => String(o.id) === d.categoryId)?.name ?? "No category"}
              value={d.categoryId}
              onChange={(e) => set({ categoryId: e.target.value })}
              className={inputClass}
            >
              <option value="">No category</option>
              {options.map((o) => (
                <option key={o.id} value={o.id} data-depth={o.depth}>
                  {o.label}
                </option>
              ))}
            </CategorySelect>
          </label>
        </div>

        <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <legend className="px-1 text-sm font-medium">The account with the service</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              Email used
              <input
                type="email"
                value={d.email}
                maxLength={200}
                onChange={(e) => set({ email: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className={label}>
              Username
              <input
                value={d.username}
                maxLength={200}
                onChange={(e) => set({ username: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>
          <label className={label}>
            Website
            <input
              value={d.website}
              maxLength={300}
              placeholder="netflix.com/account"
              onChange={(e) => set({ website: e.target.value })}
              className={inputClass}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              Free trial ends (optional)
              <input
                type="date"
                value={d.trialEndsOn}
                onChange={(e) => set({ trialEndsOn: e.target.value })}
                className={inputClass}
              />
            </label>
            <label className={label}>
              Its payments say (optional)
              <input
                value={d.paymentMatch}
                maxLength={120}
                placeholder={d.name || "NETFLIX.COM"}
                onChange={(e) => set({ paymentMatch: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>
          <p className="-mt-2 text-xs text-slate-500">
            Payments are found by this text in the merchant name; empty uses the name above.
          </p>
          <label className={label}>
            Notes
            <textarea
              value={d.notes}
              rows={2}
              maxLength={2000}
              placeholder="Plan, who shares it, how to cancel..."
              onChange={(e) => set({ notes: e.target.value })}
              className={inputClass}
            />
          </label>
          <p className="text-xs text-slate-500">
            Kept in the app&apos;s encrypted database. Don&apos;t store passwords here.
          </p>
        </fieldset>

        {d.recurringKey && (
          <p className="text-xs text-slate-500">
            Found in your history: its charges already count in the forecast, so they are not added
            to the calendar again.
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
            className={buttonClass}
            disabled={busy}
            onClick={() => onClose(false)}
          >
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
