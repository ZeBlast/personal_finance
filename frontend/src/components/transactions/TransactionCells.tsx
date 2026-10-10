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
      {t.cashback && <CashbackBadge cashback={t.cashback} />}
    </span>
  );
}

const BADGE_TONE = {
  green: "text-green-700 dark:text-green-400",
  yellow: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
} as const;

/** Green: the best card was used. Yellow: a credit card, but not the best. Red: not a credit card. */
function CashbackBadge({ cashback }: { cashback: NonNullable<Transaction["cashback"]> }) {
  const badge = cashbackBadge(cashback);
  return (
    <span className={`block text-xs font-medium ${BADGE_TONE[badge.tone]}`} title={badge.title}>
      {badge.text}
    </span>
  );
}

/** Pending, a transfer and where it went or came from, and "entered by hand", as small tags. */
export function TransactionTags({ t }: { t: Transaction }) {
  const tags: Array<{ text: string; className: string; title?: string }> = [];
  if (t.pending) tags.push({ text: "Pending", className: "bg-amber-100 text-amber-900" });
  if (t.isTransfer) {
    tags.push({
      text: transferLabel(t) ?? "Own-account transfer",
      className: "bg-blue-100 text-blue-900",
      title: "Money moved between your own accounts. It is left out of income and spending.",
    });
  }
  if (t.splits.length > 0) {
    tags.push({
      text: t.splitValid ? `Split ${t.splits.length} ways` : "Split (no longer adds up)",
      className: t.splitValid ? "bg-violet-100 text-violet-900" : "bg-amber-100 text-amber-900",
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
