import { parseMoneyToMinor } from "../../lib/money";
import type { Transaction } from "../../types/api";

/** What the form keeps for a transaction entered by hand: everything is text until it is saved. */
export interface ManualDraft {
  accountId: string;
  date: string;
  direction: "out" | "in";
  amount: string;
  merchant: string;
  description: string;
  categoryId: string;
  /** Who it was paid to (money out) or who sent it (money in). */
  person: string;
  notes: string;
  pending: boolean;
  isTransfer: boolean;
  /** Also expect it again on a schedule ("" for once only). New transactions only. */
  repeat: "" | "weekly" | "biweekly" | "monthly";
}

export const REPEAT_OPTIONS: Array<{ value: ManualDraft["repeat"]; label: string }> = [
  { value: "", label: "Does not repeat" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks (biweekly)" },
  { value: "monthly", label: "Every month" },
];

export function emptyManualDraft(today: string, accountId = ""): ManualDraft {
  return {
    accountId,
    date: today,
    direction: "out",
    amount: "",
    merchant: "",
    description: "",
    categoryId: "",
    person: "",
    notes: "",
    pending: false,
    isTransfer: false,
    repeat: "",
  };
}

/** The form's starting point for editing a transaction that already exists. */
export function draftFromTransaction(t: Transaction): ManualDraft {
  const out = t.amountMinor > 0;
  return {
    accountId: String(t.accountId),
    date: t.date,
    direction: out ? "out" : "in",
    amount: (Math.abs(t.amountMinor) / 100).toFixed(2),
    merchant: t.merchant,
    description: t.name === t.merchant ? "" : t.name,
    categoryId: t.category ? String(t.category.id) : "",
    person: (out ? t.recipient : t.sender) ?? "",
    notes: t.notes ?? "",
    pending: t.pending,
    isTransfer: t.isTransfer,
    repeat: "",
  };
}

export type ManualResult =
  { ok: true; payload: Record<string, unknown> } | { ok: false; message: string };

/**
 * Checks the form and builds what the server expects. A new transaction sends only what was filled
 * in; an edit sends every field, so clearing a box really clears it.
 */
export function buildManualPayload(
  draft: ManualDraft,
  mode: "create" | "edit",
  /** When editing: whether the transaction was a transfer before, so an unchanged box sends nothing. */
  originalTransfer?: boolean,
): ManualResult {
  if (draft.accountId === "") return { ok: false, message: "Choose the account." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
    return { ok: false, message: "Choose the date of the transaction." };
  }
  const merchant = draft.merchant.trim();
  if (merchant === "") return { ok: false, message: "Enter who the payment was with." };
  const amountMinor = parseMoneyToMinor(draft.amount, "USD");
  if (amountMinor === null) {
    return {
      ok: false,
      message:
        "Enter the amount as a positive number with at most 2 decimal places, for example 12.50. Choose money in or out above.",
    };
  }
  const person = draft.person.trim();
  const out = draft.direction === "out";
  const category = draft.categoryId === "" ? null : Number(draft.categoryId);
  const description = draft.description.trim();
  const notes = draft.notes.trim();

  if (mode === "create") {
    return {
      ok: true,
      payload: {
        accountId: Number(draft.accountId),
        date: draft.date,
        merchant,
        amountMinor,
        direction: draft.direction,
        pending: draft.pending,
        isTransfer: draft.isTransfer,
        ...(draft.repeat ? { repeat: draft.repeat } : {}),
        ...(description ? { description } : {}),
        ...(category !== null ? { categoryId: category } : {}),
        ...(person ? (out ? { recipient: person } : { sender: person }) : {}),
        ...(notes ? { notes } : {}),
      },
    };
  }
  return {
    ok: true,
    payload: {
      accountId: Number(draft.accountId),
      date: draft.date,
      merchant,
      amountMinor,
      direction: draft.direction,
      pending: draft.pending,
      // Left alone unless changed, so editing an amount does not turn an automatically matched
      // transfer into one the user decided.
      ...(originalTransfer === undefined || draft.isTransfer !== originalTransfer
        ? { isTransfer: draft.isTransfer }
        : {}),
      ...(description ? { description } : {}),
      categoryId: category,
      // Only the person that fits the direction is kept; the other is cleared.
      recipient: out ? person || null : null,
      sender: out ? null : person || null,
      notes: notes || null,
    },
  };
}
