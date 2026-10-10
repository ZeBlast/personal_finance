import { parseDecimal, parseMoneyToMinor } from "../../lib/money";

export const TRANSACTION_TYPES = [
  { value: "contribution", label: "Contribution (money in)" },
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "dividend", label: "Dividend" },
  { value: "interest", label: "Interest" },
  { value: "withdrawal", label: "Withdrawal (money out)" },
  { value: "fee", label: "Fee" },
  { value: "transfer", label: "Transfer" },
  { value: "other", label: "Other" },
] as const;

export interface TransactionDraft {
  date: string;
  type: string;
  fund: string;
  quantity: string;
  price: string;
  amount: string;
  fees: string;
  description: string;
  /** A finer label, such as "employer match" (optional). */
  subtype: string;
  /** When it happened, if known (optional). */
  datetime: string;
}

export interface TransactionPayload {
  date: string;
  type: string;
  symbol?: string;
  name?: string;
  description?: string;
  quantity?: number;
  price?: number;
  amountMinor?: number;
  feesMinor?: number;
  subtype?: string;
  datetime?: string;
}

export type TransactionResult =
  { ok: true; payload: TransactionPayload } | { ok: false; message: string };

/** Types whose direction is fixed; the others (transfer, other) take the sign the user types. */
const SIGNED_BY_USER = new Set(["transfer", "other"]);

export function buildTransactionPayload(draft: TransactionDraft): TransactionResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
    return { ok: false, message: "Choose the date of the transaction." };
  }
  const quantity = draft.quantity.trim() === "" ? null : parseDecimal(draft.quantity);
  if (draft.quantity.trim() !== "" && quantity === null) {
    return { ok: false, message: "The quantity must be a number, for example 10 or 2.5." };
  }
  const price = draft.price.trim() === "" ? null : parseDecimal(draft.price);
  if (draft.price.trim() !== "" && price === null) {
    return { ok: false, message: "The price must be a number, for example 98.12." };
  }

  let amountMinor: number | null = null;
  const typed = draft.amount.trim();
  if (typed !== "") {
    const negative = typed.startsWith("-");
    const magnitude = parseMoneyToMinor(negative ? typed.slice(1) : typed, "USD", {
      allowZero: true,
    });
    if (magnitude === null) {
      return { ok: false, message: "Enter the amount in dollars, for example 500.00." };
    }
    if (negative && !SIGNED_BY_USER.has(draft.type)) {
      return {
        ok: false,
        message: `Enter the ${draft.type} amount as a positive number; the type says which way the money moves.`,
      };
    }
    amountMinor = negative ? -magnitude : magnitude;
  } else if (quantity === null || price === null) {
    return { ok: false, message: "Enter the amount, or both a quantity and a price." };
  }

  const fees =
    draft.fees.trim() === "" ? null : parseMoneyToMinor(draft.fees, "USD", { allowZero: true });
  if (draft.fees.trim() !== "" && fees === null) {
    return { ok: false, message: "Enter fees in dollars, or leave the box empty." };
  }

  if (
    draft.datetime.trim() !== "" &&
    !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(draft.datetime.trim())
  ) {
    return { ok: false, message: "Enter the time as YYYY-MM-DDTHH:MM, or leave it empty." };
  }

  const fund = draft.fund.trim();
  const looksLikeSymbol = /^[A-Za-z0-9.-]{1,12}$/.test(fund);
  return {
    ok: true,
    payload: {
      date: draft.date,
      type: draft.type,
      ...(fund ? (looksLikeSymbol ? { symbol: fund } : { name: fund }) : {}),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      ...(draft.subtype.trim() ? { subtype: draft.subtype.trim() } : {}),
      ...(draft.datetime.trim() ? { datetime: draft.datetime.trim() } : {}),
      ...(quantity !== null ? { quantity } : {}),
      ...(price !== null ? { price } : {}),
      ...(amountMinor !== null ? { amountMinor } : {}),
      ...(fees !== null ? { feesMinor: fees } : {}),
    },
  };
}
