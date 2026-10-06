/**
 * Finds the person on the other side of a transfer such as a Zelle payment.
 *
 * Plaid does not reliably supply this, so, in order:
 *   1. the provider's payment metadata (`payee` for money going out, `payer` for money coming in);
 *   2. patterns read from the transaction description (below, easy to extend);
 *   3. otherwise nothing, and the user can type it in (stored separately, never overwritten).
 */

export interface RecipientInput {
  name: string;
  /** Plaid sign convention: positive = money leaves the account. */
  amount: number;
  paymentPayee: string | null;
  paymentPayer: string | null;
}

export interface RecipientResult {
  recipient: string;
  source: "plaid" | "parsed";
}

/** Each pattern's first capture group is the person's name. Matched case-insensitively. */
const PATTERNS: RegExp[] = [
  /\bzelle\s+(?:payment|transfer|money)?\s*(?:to|from)\s+(.+)$/i,
  /\bzelle\s+(?:to|from)\s+(.+)$/i,
];

/** Trailing reference numbers, confirmation codes, and similar noise after the name. */
const TRAILING_NOISE =
  /\s+(?:(?:conf(?:irmation)?|ref(?:erence)?|id|trace|txn|#)\b.*|[a-z]{0,4}\d{3,}\S*.*)$/i;

function tidy(raw: string): string | null {
  let name = raw.replace(/\s+/g, " ").trim();
  name = name
    .replace(TRAILING_NOISE, "")
    .replace(/[\s,.;:*-]+$/g, "")
    .trim();
  if (name.length < 2) return null;
  return name.slice(0, 100);
}

export function extractRecipient(input: RecipientInput): RecipientResult | null {
  const outgoing = input.amount > 0;
  const fromMeta = outgoing ? input.paymentPayee : input.paymentPayer;
  const meta = fromMeta ? tidy(fromMeta) : null;
  if (meta) return { recipient: meta, source: "plaid" };

  for (const pattern of PATTERNS) {
    const match = pattern.exec(input.name);
    const captured = match?.[1] ? tidy(match[1]) : null;
    if (captured) return { recipient: captured, source: "parsed" };
  }
  return null;
}

/** Whether a transaction is a transfer between people or accounts rather than a purchase. */
export function looksLikeTransfer(
  categoryPrimary: string | null,
  recipient: RecipientResult | null,
): boolean {
  return (categoryPrimary?.startsWith("TRANSFER") ?? false) || recipient !== null;
}
