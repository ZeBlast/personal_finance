import { accountLabel } from "../../lib/accountLabel";
import { cashbackBadge } from "../../lib/cashback";
import { formatMinor } from "../../lib/money";
import { transferLabel } from "../../lib/transferLabel";
import type { Transaction } from "../../types/api";

/** Table cells shared by the Transactions page and the calendar's day table. */

export function AmountCell({ t }: { t: Transaction }) {
  // The data uses Plaid's convention (positive = money out); show it the way people read it:
  // spending as a minus, money in as a plus.
  const shown = -t.amountMinor;
  return (
    <span
      className={`tabular-nums ${shown > 0 ? "font-medium text-green-700 dark:text-green-400" : ""}`}
    >
      {shown > 0 ? "+" : ""}
      {formatMinor(shown, t.currency)}
      {t.cashback && !t.isTransfer && !t.refundOf && shown < 0 && (
        <CashbackBadge cashback={t.cashback} />
      )}
    </span>
  );
}

const BADGE_TONE = {
  green: "text-green-700 dark:text-green-400",
  yellow: "text-amber-800 dark:text-amber-400",
  muted: "text-slate-500 dark:text-slate-400",
} as const;

/**
 * Green: the best card was used. Yellow: a credit card, but not the best. Muted: not a credit card,
 * naming the card that would have earned (nothing when none would).
 */
function CashbackBadge({ cashback }: { cashback: NonNullable<Transaction["cashback"]> }) {
  const badge = cashbackBadge(cashback);
  if (!badge) return null;
  return (
    <span className={`block text-xs font-medium ${BADGE_TONE[badge.tone]}`} title={badge.title}>
      {badge.text}
    </span>
  );
}

const isPaypal = (other: { accountName: string; institutionName: string | null }): boolean =>
  /paypal/i.test(`${other.institutionName ?? ""} ${other.accountName}`);

/**
 * For one purchase shown on two accounts (a PayPal purchase and what paid it): on the PayPal row,
 * "Paid using Visa" (the paying account's own name, without its institution); on the paying
 * row, "Paid via PayPal".
 */
export function mirrorLabel(t: Pick<Transaction, "mirror" | "amountMinor">): string | null {
  if (!t.mirror) return null;
  const other = t.mirror.with;
  // Money back (a refund): where PayPal paid it out to, or that it came through PayPal.
  if (t.amountMinor < 0) {
    return isPaypal(other) ? `Refund via ${other.accountName}` : `Refunded to ${other.accountName}`;
  }
  return isPaypal(other) ? `Paid via ${other.accountName}` : `Paid using ${other.accountName}`;
}

/** An account's name on one line, cut with an ellipsis; the institution is in the tooltip. */
export function AccountCell({
  t,
}: {
  t: Pick<Transaction, "accountName" | "institutionName" | "accountColor">;
}) {
  return (
    <span className="flex items-center" title={accountLabel(t.accountName, t.institutionName)}>
      <span
        aria-hidden="true"
        className="mr-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
      />
      <span className="truncate">{t.accountName}</span>
    </span>
  );
}

/** For a transfer between your own accounts: where it went or came from, as one muted line. */
export function TransferNote({ t }: { t: Transaction }) {
  if (!t.isTransfer || mirrorLabel(t)) return null;
  return (
    <span
      className="block truncate text-xs text-slate-500"
      title={`${transferLabel(t) ?? "Own-account transfer"}. Money moved between your own accounts. It is left out of income and spending.`}
    >
      {transferLabel(t, true) ?? "Own-account transfer"}
    </span>
  );
}

/** A purchase shown on two accounts, a split, a refund, and "entered by hand", as small tags. */
export function TransactionTags({ t }: { t: Transaction }) {
  const tags: Array<{ text: string; className: string; title?: string }> = [];
  const mirrorTag = mirrorLabel(t);
  if (mirrorTag) {
    tags.push({
      text: mirrorTag,
      className: "bg-sky-100 text-sky-900",
      title:
        t.mirror!.role === "copy"
          ? `The same purchase as on ${t.mirror!.with.accountName}, which counts it. It is left out of totals here.`
          : `The same purchase also shows on ${t.mirror!.with.accountName}. This one counts it.`,
    });
  }
  if (t.refundOf) {
    tags.push({
      text: `Refund of ${t.refundOf.merchant}`,
      className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200",
      title: `${
        t.refundOf.source === "auto" ? "Found by the app. " : ""
      }Counted against that purchase, in its category and month, not as income.`,
    });
  }
  if (t.refundedMinor > 0) {
    tags.push({
      text: `Refunded ${formatMinor(t.refundedMinor, t.currency)}`,
      className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200",
      title: "Linked refunds give this much back. Totals count only what was kept.",
    });
  }
  if (t.splits.length > 0) {
    tags.push({
      text: t.splitValid ? `Split ${t.splits.length} ways` : "Split (no longer adds up)",
      className: t.splitValid
        ? "bg-violet-100 text-violet-900 dark:bg-violet-950/60 dark:text-violet-200"
        : "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
      title: t.splits
        .map(
          (s) =>
            `${s.categoryName ?? "Uncategorized"}: ${(Math.abs(s.amountMinor) / 100).toFixed(2)}`,
        )
        .join(", "),
    });
  }
  if (t.source === "manual") {
    tags.push({
      text: "Entered by hand",
      className: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
    });
  }
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag.text}
          title={tag.title}
          className={`rounded-xl px-2 py-0.5 text-xs leading-tight font-medium ${tag.className}`}
        >
          {tag.text}
        </span>
      ))}
    </span>
  );
}
