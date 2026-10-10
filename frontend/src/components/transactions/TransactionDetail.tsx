import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { api, errorMessage } from "../../api/client";
import { categoryOptions } from "../../hooks/useCategories";
import { cashbackBadge, formatRate } from "../../lib/cashback";
import { Attachments } from "./Attachments";
import { transferLabel } from "../../lib/transferLabel";
import { formatMinor } from "../../lib/money";
import { categoryLabel, formatDay } from "../../lib/time";
import type { Category, Rule, RulePreview, Transaction } from "../../types/api";
import { Modal } from "../common/Modal";
import { useUnsavedGuard } from "../common/useUnsavedGuard";
import { BankDetails } from "./BankDetails";
import { CategorySelect } from "../common/CategorySelect";

type TransferChoice = "auto" | "yes" | "no";
type OnlineChoice = "auto" | "yes" | "no";

/** What the bank's payment channel says about whether a purchase was online, in words. */
function bankOnlineText(t: Transaction): string {
  if (t.providerOnline === true) return "online";
  if (t.providerOnline === false) return "in store";
  return t.paymentChannel ? `not clear (“${t.paymentChannel}”)` : "not given";
}

interface Props {
  transaction: Transaction;
  categories: Category[];
  onClose: () => void;
  /** Called with the saved transaction, and with how many others a new rule recategorized. */
  onSaved: (updated: Transaction, rule?: { name: string; changed: number }) => void;
  /** Offered when set: closes this and opens the split editor. */
  onSplit?: (() => void) | undefined;
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

export function TransactionDetail({
  transaction: t,
  categories,
  onClose,
  onSaved,
  onSplit,
}: Props) {
  const transaction = t;
  const id = useId();
  const [merchant, setMerchant] = useState(t.merchantEdited ? t.merchant : "");
  // The other party is a recipient when money went out and a sender when it came in.
  const incoming = t.amountMinor < 0;
  const detectedPerson = incoming ? t.providerSender : t.providerRecipient;
  const personWasEdited = incoming ? t.senderSource === "manual" : t.recipientSource === "manual";
  const personOnRecord = (incoming ? t.sender : t.recipient) ?? "";
  const [person, setPerson] = useState(personWasEdited ? personOnRecord : "");
  const [notes, setNotes] = useState(t.notes ?? "");
  const initialTransfer: TransferChoice =
    t.transferSource === "manual" ? (t.isTransfer ? "yes" : "no") : "auto";
  const [transfer, setTransfer] = useState<TransferChoice>(initialTransfer);
  const initialOnline: OnlineChoice = t.onlineEdited ? (t.online ? "yes" : "no") : "auto";
  const [online, setOnline] = useState<OnlineChoice>(initialOnline);
  const [categoryId, setCategoryId] = useState<string>(t.category ? String(t.category.id) : "");
  const [makeRule, setMakeRule] = useState(false);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const options = categoryOptions(categories);
  const shownMerchant = merchant.trim() || t.providerMerchant;
  const categoryChanged = categoryId !== (t.category ? String(t.category.id) : "");
  const chosenName = options.find((o) => String(o.id) === categoryId)?.name;
  const dirty =
    merchant !== (t.merchantEdited ? t.merchant : "") ||
    person !== (personWasEdited ? personOnRecord : "") ||
    notes !== (t.notes ?? "") ||
    transfer !== initialTransfer ||
    online !== initialOnline ||
    categoryChanged ||
    makeRule;
  const { requestClose, confirm } = useUnsavedGuard(dirty && !saving, onClose);

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
      if (person.trim() !== (personWasEdited ? personOnRecord : "")) {
        patch[incoming ? "sender" : "recipient"] = person.trim() || null;
      }
      if (notes.trim() !== (t.notes ?? "")) patch["notes"] = notes.trim() || null;
      if (transfer !== initialTransfer) {
        patch["isTransfer"] = transfer === "auto" ? null : transfer === "yes";
      }

      if (online !== initialOnline) {
        patch["online"] = online === "auto" ? null : online === "yes";
      }

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
    <Modal title="Transaction" onClose={requestClose} wide dismissible>
      {confirm}
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
          {t.cashback && (
            <Field label="Cashback">
              {t.cashback.status === "missed"
                ? "None: not paid with a credit card"
                : `${formatMinor(t.cashback.cashbackMinor, t.currency)} at ${formatRate(t.cashback.rateBps)}${t.cashback.online ? " (online rate)" : ""}`}
              <span className="text-slate-500">
                {" "}
                · {cashbackBadge(t.cashback).title} Cashback is kept apart from balances until the
                card pays it as a credit.
              </span>
            </Field>
          )}
          <Field label="Online purchase">
            {t.online ? "Yes, online" : "No"}
            <span className="text-slate-500">
              {t.onlineEdited
                ? ` · set by you (the bank says ${bankOnlineText(t)})`
                : ` · from the bank (${bankOnlineText(t)})`}
            </span>
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

        <BankDetails details={t.details} />

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
          <CategorySelect
            shown={chosenName ?? "Uncategorized (let the rules decide)"}
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
          </CategorySelect>
          {onSplit && (
            <button
              type="button"
              className="mt-1 text-xs text-blue-700 underline dark:text-blue-400"
              onClick={() =>
                dirty ? setError("Save or cancel your changes first, then split it.") : onSplit()
              }
            >
              {transaction.splits.length > 0 ? "Change the split..." : "Split across categories..."}
            </button>
          )}
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
          <label htmlFor={`${id}-person`} className="block text-sm font-medium">
            {incoming ? "Sender" : "Recipient"}
          </label>
          <input
            id={`${id}-person`}
            value={person}
            maxLength={100}
            placeholder={
              detectedPerson ??
              (incoming ? "Who sent you this money?" : "Who was this paid or sent to?")
            }
            onChange={(e) => setPerson(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            {detectedPerson
              ? `Detected: ${detectedPerson}. Leave blank to use it.`
              : incoming
                ? "Who sent you this money. Useful for transfers such as Zelle."
                : "Useful for transfers such as Zelle."}
          </p>
        </div>

        <div>
          <label htmlFor={`${id}-transfer`} className="block text-sm font-medium">
            Transfer between my own accounts
          </label>
          <select
            id={`${id}-transfer`}
            value={transfer}
            onChange={(e) => setTransfer(e.target.value as TransferChoice)}
            className={inputClass}
          >
            <option value="auto">
              Let the app decide (now:{" "}
              {t.isTransfer && t.transferSource !== "manual" ? "yes" : "no"})
            </option>
            <option value="yes">Yes, money moved between my own accounts</option>
            <option value="no">No, this is income or spending</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            {t.transferWith && t.transferSource === "auto"
              ? `${transferLabel(t)}, ${formatDay(t.transferWith.transactionDate)}. `
              : ""}
            Transfers between your own accounts are left out of income and spending. Money sent to
            or received from another person counts.
          </p>
        </div>

        <div>
          <label htmlFor={`${id}-online`} className="block text-sm font-medium">
            Bought online
          </label>
          <select
            id={`${id}-online`}
            value={online}
            onChange={(e) => setOnline(e.target.value as OnlineChoice)}
            className={inputClass}
          >
            <option value="auto">
              Use the bank&apos;s answer (now: {t.providerOnline === true ? "online" : "not online"}
              )
            </option>
            <option value="yes">Yes, this was bought online</option>
            <option value="no">No, this was not bought online</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Cards with an online cashback rate use this. The bank&apos;s answer is a guess and is
            sometimes wrong, and your choice is kept when the account syncs.
          </p>
        </div>

        <Attachments transactionId={t.id} />

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
            onClick={requestClose}
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
