import { AccountName } from "../common/AccountName";
import { Modal } from "../common/Modal";
import { AmountCell, TransactionTags } from "../transactions/TransactionCells";
import { useApi } from "../../hooks/useApi";
import { useDateBasis } from "../../hooks/useDateBasis";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { CalendarEvent } from "../../types/calendar";
import type { Transaction } from "../../types/api";
import { LoadMore } from "./LoadMore";
import { usePagedTransactions } from "./usePagedTransactions";
import { spanTitle, type DaySpan } from "./range";
import { Loading } from "../common/Loading";

const LIMIT = 200; // the most the server returns at once

/**
 * The selected days' transactions as a table like the Transactions page, with what is still
 * expected in those days listed first.
 */
export function DayTransactionsTable({
  span,
  accountId,
  onOpen,
  onClose,
}: {
  span: DaySpan;
  accountId: string;
  /** Opens one transaction (its editor, or a bank one's details). */
  onOpen: (t: Transaction) => void;
  onClose: () => void;
}) {
  const basis = useDateBasis();
  const txQuery = new URLSearchParams({
    from: span.from,
    to: span.to,
    pageSize: String(LIMIT),
    sort: basis === "posted" ? "date_desc" : "txdate_desc",
    dateBasis: basis,
  });
  const plannedQuery = new URLSearchParams({ from: span.from, to: span.to });
  if (accountId) {
    txQuery.set("accountId", accountId);
    plannedQuery.set("accountId", accountId);
  }
  const list = usePagedTransactions(txQuery);
  const txs = {
    data: list.items ? { items: list.items } : null,
    loading: list.loading,
    error: list.error,
  };
  const planned = useApi<CalendarEvent[]>(`/calendar/expected?${plannedQuery}`);
  // A pending entry already listed below (its own date is in these days) is not listed twice.
  const listed = new Set((txs.data?.items ?? []).map((t) => t.id));
  const expected = (planned.data ?? []).filter(
    (o) => o.status === "expected" && !(o.transactionId !== null && listed.has(o.transactionId)),
  );
  const error = txs.error ?? planned.error;
  const empty = txs.data && planned.data && txs.data.items.length === 0 && expected.length === 0;

  return (
    <Modal title={`Transactions: ${spanTitle(span)}`} onClose={onClose} wide="full" dismissible>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {(txs.loading || planned.loading) && <Loading />}
      {empty && <p className="text-sm text-slate-500">Nothing in these days.</p>}
      {!empty && txs.data && planned.data && (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <tr>
                <th className="px-2 py-2 font-medium">Date</th>
                <th className="px-2 py-2 font-medium">Posted</th>
                <th className="px-2 py-2 font-medium">Merchant</th>
                <th className="px-2 py-2 font-medium">Category</th>
                <th className="px-2 py-2 font-medium">Online</th>
                <th className="px-2 py-2 font-medium">Account</th>
                <th className="px-2 py-2 font-medium">Recipient</th>
                <th className="px-2 py-2 text-right font-medium">Amount</th>
                <th className="px-2 py-2 font-medium">Tags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {expected.map((o) => (
                <tr
                  key={o.id}
                  className="bg-violet-50/60 text-slate-600 dark:bg-violet-950/30 dark:text-slate-300"
                >
                  <td className="px-2 py-2 whitespace-nowrap">{formatDay(o.date)}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">
                    {o.source === "pending" ? `Pending since ${formatDay(o.originalDate)}` : "—"}
                  </td>
                  <td className="max-w-56 min-w-32 px-2 py-2 font-medium">{o.merchant}</td>
                  <td className="px-2 py-2">{o.categoryName ?? "Uncategorized"}</td>
                  <td className="px-2 py-2" />
                  <td className="max-w-56 min-w-32 px-2 py-2">{o.accountName ?? ""}</td>
                  <td className="max-w-32 px-2 py-2 break-words">{o.person ?? ""}</td>
                  <td
                    className={`min-w-28 px-2 py-2 text-right whitespace-nowrap tabular-nums ${o.direction === "in" ? "text-green-700 dark:text-green-400" : ""}`}
                  >
                    {o.direction === "in"
                      ? `+${formatMinor(o.amountMinor, "USD")}`
                      : formatMinor(-o.amountMinor, "USD")}
                  </td>
                  <td className="w-44 min-w-36 px-2 py-2">
                    <span className="rounded-xl bg-violet-100 px-2 py-0.5 text-xs leading-tight font-medium text-violet-900 dark:bg-violet-950/60 dark:text-violet-200">
                      {o.source === "pending" ? "Expected · pending manual" : "Expected · planned"}
                    </span>
                  </td>
                </tr>
              ))}
              {txs.data.items.map((t) => (
                <tr key={t.id}>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {formatDay(t.authorizedDate ?? t.date)}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-slate-500 dark:text-slate-400">
                    {t.pending ? "Pending" : formatDay(t.date)}
                  </td>
                  <td className="max-w-56 min-w-32 px-2 py-2 font-medium">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      title="Open this transaction"
                      onClick={() => onOpen(t)}
                    >
                      {t.merchant}
                    </button>
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block h-2.5 w-2.5 rounded-full"
                      style={{
                        backgroundColor: t.category?.color ?? "transparent",
                        border: t.category?.color ? undefined : "1px solid #94a3b8",
                      }}
                    />
                    {t.category?.name ?? "Uncategorized"}
                  </td>
                  <td className="px-2 py-2 text-center">{t.online ? "✓" : ""}</td>
                  <td className="max-w-56 min-w-32 px-2 py-2">
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
                    />
                    <AccountName name={t.accountName} institutionName={t.institutionName} />
                  </td>
                  <td className="max-w-32 px-2 py-2 break-words text-slate-600 dark:text-slate-300">
                    {(t.amountMinor > 0 ? t.recipient : t.sender) ?? ""}
                  </td>
                  <td className="min-w-28 px-2 py-2 text-right whitespace-nowrap">
                    <AmountCell t={t} />
                  </td>
                  <td className="w-44 min-w-36 px-2 py-2">
                    <TransactionTags t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.items && (
        <LoadMore
          shown={list.items.length}
          total={list.total}
          busy={list.loadingMore}
          onMore={() => void list.loadMore()}
        />
      )}
    </Modal>
  );
}
