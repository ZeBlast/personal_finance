import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { api, errorMessage } from "../../api/client";
import { categoryOptions } from "../../hooks/useCategories";
import { formatMinor } from "../../lib/money";
import { categoryLabel, formatDay } from "../../lib/time";
import type { Category, Rule, RulePreview, Transaction } from "../../types/api";
import { Modal } from "../common/Modal";

interface Props {
  transaction: Transaction;
  categories: Category[];
  onClose: () => void;
  /** Called with the saved transaction, and with how many others a new rule recategorized. */
  onSaved: (updated: Transaction, rule?: { name: string; changed: number }) => void;
}

const inputClass =
  "mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** How the current category got there, in words. */
function categorySourceText(t: Transaction): string {
  if (!t.category) return "No category yet. Choose one below, or create a rule.";
  if (t.category.source === "manual") return "Chosen by you. Rules will not change it.";
  return `Set by the rule “${t.category.ruleName ?? "unknown"}”.`;
}

export function TransactionDetail({ transaction: t, categories, onClose, onSaved }: Props) {
  const id = useId();
  const [merchant, setMerchant] = useState(t.merchantEdited ? t.merchant : "");
  const [recipient, setRecipient] = useState(
    t.recipientSource === "manual" ? (t.recipient ?? "") : "",
  );
  const [notes, setNotes] = useState(t.notes ?? "");
  const [categoryId, setCategoryId] = useState<string>(t.category ? String(t.category.id) : "");
  const [makeRule, setMakeRule] = useState(false);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const options = categoryOptions(categories);
  const shownMerchant = merchant.trim() || t.providerMerchant;
  const categoryChanged = categoryId !== (t.category ? String(t.category.id) : "");
  const chosenName = options.find((o) => String(o.id) === categoryId)?.label;

  // When "always categorize this merchant" is ticked, show how many transactions it would affect.
  useEffect(() => {
    if (!makeRule || categoryId === "") {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api<RulePreview>("/rules/preview", {
      method: "POST",
      body: JSON.stringify({ field: "merchant", operator: "equals", matchValue: shownMerchant }),
    })
      .then((result) => !cancelled && setPreview(result))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [makeRule, categoryId, shownMerchant]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (categoryChanged) patch["categoryId"] = categoryId === "" ? null : Number(categoryId);
      if (merchant.trim() !== (t.merchantEdited ? t.merchant : ""))
        patch["merchant"] = merchant.trim() || null;
      if (recipient.trim() !== (t.recipientSource === "manual" ? (t.recipient ?? "") : "")) {
        patch["recipient"] = recipient.trim() || null;
      }
      if (notes.trim() !== (t.notes ?? "")) patch["notes"] = notes.trim() || null;

      let updated = t;
      if (Object.keys(patch).length > 0) {
        updated = await api<Transaction>(`/transactions/${t.id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
      }

      let ruleResult: { name: string; changed: number } | undefined;
      if (makeRule && categoryId !== "") {
        const name = `${shownMerchant} → ${chosenName ?? "category"}`;
        const rule = await api<Rule>("/rules", {
          method: "POST",
          body: JSON.stringify({
            name,
            field: "merchant",
            operator: "equals",
            matchValue: shownMerchant,
            categoryId: Number(categoryId),
          }),
        });
        const applied = await api<{ changed: number }>("/rules/apply", {
          method: "POST",
          body: "{}",
        });
        ruleResult = { name: rule.name, changed: applied.changed };
        updated = await api<Transaction>(`/transactions/${t.id}`);
      }
      onSaved(updated, ruleResult);
    } catch (e) {
      setError(errorMessage(e, "Could not save the changes."));
      setSaving(false);
    }
  }

  return (
    <Modal title="Transaction" onClose={onClose} wide>
      <form onSubmit={(e) => void save(e)} className="space-y-4">
        <dl className="space-y-1">
          <Field label="Date">
            {formatDay(t.date)}
            {t.authorizedDate && t.authorizedDate !== t.date && (
              <span className="text-slate-500"> (authorized {formatDay(t.authorizedDate)})</span>
            )}
            {t.pending && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                Pending
              </span>
            )}
          </Field>
          <Field label="Amount">
            <span className="font-medium">{formatMinor(-t.amountMinor, t.currency)}</span>
            <span className="text-slate-500">
              {" "}
              {t.amountMinor > 0 ? "(money out)" : "(money in)"}
            </span>
          </Field>
          <Field label="Account">
            <span
              aria-hidden="true"
              className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
            />
            {t.accountName}
            {t.institutionName ? ` · ${t.institutionName}` : ""}
          </Field>
          <Field label="Bank description">
            <span className="break-words">{t.name}</span>
          </Field>
          <Field label="Bank category">
            {categoryLabel(t.categoryPrimary, t.categoryDetailed)}
            {t.paymentChannel ? (
              <span className="text-slate-500"> · {t.paymentChannel}</span>
            ) : null}
          </Field>
        </dl>

        <div>
          <label htmlFor={`${id}-merchant`} className="block text-sm font-medium">
            Merchant
          </label>
          <input
            id={`${id}-merchant`}
            value={merchant}
            maxLength={200}
            placeholder={t.providerMerchant}
            onChange={(e) => setMerchant(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave blank to use the bank’s name (“{t.providerMerchant}”).
          </p>
        </div>

        <div>
          <label htmlFor={`${id}-category`} className="block text-sm font-medium">
            Category
          </label>
          <select
            id={`${id}-category`}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            aria-describedby={`${id}-category-help`}
            className={inputClass}
          >
            <option value="">Uncategorized (let the rules decide)</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <p id={`${id}-category-help`} className="mt-1 text-xs text-slate-500">
            {categoryChanged && categoryId !== ""
              ? "Saving will mark this category as chosen by you."
              : categoryChanged
                ? "Saving will hand this transaction back to the rules."
                : categorySourceText(t)}
          </p>
          {categoryChanged && categoryId !== "" && (
            <label className="mt-2 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={makeRule}
                onChange={(e) => setMakeRule(e.target.checked)}
                className="mt-1"
              />
              <span>
                Always categorize “{shownMerchant}” as {chosenName} (creates a rule and updates
                matching transactions
                {preview ? `: ${preview.matchCount} found` : ""}).
              </span>
            </label>
          )}
        </div>

        <div>
          <label htmlFor={`${id}-recipient`} className="block text-sm font-medium">
            Recipient or sender
          </label>
          <input
            id={`${id}-recipient`}
            value={recipient}
            maxLength={100}
            placeholder={t.providerRecipient ?? "Who was this sent to or received from?"}
            onChange={(e) => setRecipient(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            {t.providerRecipient
              ? `Detected: ${t.providerRecipient}. Leave blank to use it.`
              : "Useful for transfers such as Zelle."}
          </p>
        </div>

        <div>
          <label htmlFor={`${id}-notes`} className="block text-sm font-medium">
            Notes
          </label>
          <textarea
            id={`${id}-notes`}
            value={notes}
            rows={3}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
            className={inputClass}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
