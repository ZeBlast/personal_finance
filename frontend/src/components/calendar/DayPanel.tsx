import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { useDateBasis } from "../../hooks/useDateBasis";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { Account, Category, Transaction } from "../../types/api";
import type { CalendarEvent, PeriodSummary, PlannedItem } from "../../types/calendar";
import { ManualTransactionDialog } from "../transactions/ManualTransactionDialog";
import { SplitDialog } from "../transactions/SplitDialog";
import { TransactionDetail } from "../transactions/TransactionDetail";
import { ChangeOccurrenceForm, QuickAddExpected } from "./ExpectedEditing";
import { ForecastSection } from "./ForecastSection";
import { LoadMore } from "./LoadMore";
import { usePagedTransactions } from "./usePagedTransactions";
import { buttonClass, primaryClass } from "../investments/styles";
import { DayTransactionsTable } from "./DayTransactionsTable";
import { NoteBox } from "./NoteBox";
import { PlannedDialog } from "./PlannedDialog";
import { isSingleDay, spanTitle, type DaySpan } from "./range";
import { Loading } from "../common/Loading";

type Tab = "transactions" | "notes" | "expected";

const TX_LIMIT = 200;

const smallButton =
  "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";

/** Money with its direction: "+$40.00" for a gain, "−$10.00" for a loss, "$0.00" for none. */
export function signedMoney(minor: number, currency: string): string {
  if (minor === 0) return formatMinor(0, currency);
  return `${minor > 0 ? "+" : "−"}${formatMinor(Math.abs(minor), currency)}`;
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "debt" | undefined;
  hint?: string | undefined;
}) {
  return (
    <div className="rounded-md border border-slate-200 p-2 dark:border-slate-700">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className={`text-base font-semibold tabular-nums ${
          tone === "good"
            ? "text-green-700 dark:text-green-400"
            : tone === "bad"
              ? "text-red-700 dark:text-red-400"
              : tone === "debt"
                ? "text-sky-700 dark:text-sky-400"
                : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

/**
 * Everything beyond the three balances (money in and out, debt, counts, categories and how it is
 * all worked out), folded away so the day's details come first.
 */
function MoreFigures({ s, single }: { s: PeriodSummary; single: boolean }) {
  const c = s.currency;
  const change = s.balance.changeMinor;
  return (
    <details className="group rounded-md border border-slate-200 dark:border-slate-700">
      <summary className="cursor-pointer px-2 py-1.5 text-xs text-slate-600 select-none dark:text-slate-300">
        More figures: money in and out, debt
        {single ? "" : ", spending"} and how it is worked out
      </summary>
      <div className="space-y-2 border-t border-slate-200 p-2 dark:border-slate-700">
        <div className="grid grid-cols-2 gap-2">
          <Figure
            label="Change in cash and cards"
            value={change === null ? "Not known" : signedMoney(change, c)}
            tone={change === null || change === 0 ? undefined : change > 0 ? "good" : "bad"}
            hint={single ? "over the day" : "over the span"}
          />
          <Figure label="Money in" value={formatMinor(s.moneyInMinor, c)} tone="good" />
          <Figure label="Money out" value={formatMinor(s.moneyOutMinor, c)} />
          {(s.debtPaidMinor > 0 || s.debt.accountsCounted > 0) && (
            <>
              <Figure
                label="Debt paid"
                value={formatMinor(s.debtPaidMinor, c)}
                tone={s.debtPaidMinor > 0 ? "debt" : undefined}
                hint="to cards and loans, not spending"
              />
              <Figure
                label={
                  s.balance.projected ? "Cards and loans owed (projected)" : "Cards and loans owed"
                }
                value={s.debt.endMinor === null ? "Not known" : formatMinor(s.debt.endMinor, c)}
                hint="at the end"
              />
              <Figure
                label="Change in debt"
                value={
                  s.debt.changeMinor === null ? "Not known" : signedMoney(s.debt.changeMinor, c)
                }
                // Less debt is the good direction.
                tone={
                  s.debt.changeMinor === null || s.debt.changeMinor === 0
                    ? undefined
                    : s.debt.changeMinor < 0
                      ? "good"
                      : "bad"
                }
                hint={single ? "over the day" : "over the span"}
              />
            </>
          )}
          <Figure
            label="Transactions"
            value={String(s.transactionCount)}
            hint={s.pendingCount > 0 ? `${s.pendingCount} pending` : undefined}
          />
          {!single && (
            <>
              <Figure
                label="Spending"
                value={formatMinor(s.spendingMinor, c)}
                hint="own-account transfers left out"
              />
              <Figure
                label="Income"
                value={formatMinor(s.incomeMinor, c)}
                hint="own-account transfers left out"
              />
            </>
          )}
        </div>
        {s.expected.count > 0 && (
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Still expected: {s.expected.count} item{s.expected.count === 1 ? "" : "s"}
            {s.expected.outflowMinor > 0 && <>, {formatMinor(s.expected.outflowMinor, c)} out</>}
            {s.expected.inflowMinor > 0 && <>, {formatMinor(s.expected.inflowMinor, c)} in</>}.
          </p>
        )}
        {!single && s.topCategories.length > 0 && (
          <div>
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Top spending categories
            </div>
            <ul className="mt-1 space-y-0.5 text-sm">
              {s.topCategories.map((cat) => (
                <li key={cat.label} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: cat.color ?? "#94a3b8" }}
                    />
                    <span className="truncate">{cat.label}</span>
                  </span>
                  <span className="tabular-nums">{formatMinor(cat.spendingMinor, c)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <HowCalculated s={s} />
      </div>
    </details>
  );
}

/**
 * Cash, card debt and the two together as separate figures, so the total is never mistaken for
 * money in the bank. A future day is labelled projected and shows how it was reached.
 */
function BalanceFigures({ s, single }: { s: PeriodSummary; single: boolean }) {
  const c = s.currency;
  const b = s.balance;
  const money = (v: number | null): string => (v === null ? "Not known" : formatMinor(v, c));
  const at = single ? "end of the day" : "end of the span";
  if (b.accountsCounted === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-2 text-xs text-slate-500 dark:border-slate-600 dark:text-slate-400">
        No balance to show: none of the chosen accounts is a cash account or card with a known
        balance. Investment and loan accounts are not part of this calendar&apos;s balance.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400">
        {b.projected && (
          <span className="rounded-full bg-violet-100 px-2 font-medium text-violet-900 dark:bg-violet-950 dark:text-violet-200">
            Projected
          </span>
        )}
        <span>Balances at the {at}</span>
        {b.changeMinor !== null && (
          <span
            className={`font-medium tabular-nums ${b.changeMinor > 0 ? "text-green-700 dark:text-green-400" : b.changeMinor < 0 ? "text-red-700 dark:text-red-400" : ""}`}
          >
            {signedMoney(b.changeMinor, c)} {single ? "over the day" : "over the span"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Figure label="Cash" value={money(b.cash.endMinor)} />
        <Figure
          label="Card debt"
          value={money(b.cardDebt.endMinor)}
          hint={b.cardDebt.endMinor === null ? "no card counted" : undefined}
        />
        <Figure label="Cash minus cards" value={money(b.endMinor)} />
      </div>
      {b.projection && (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          <span className="whitespace-nowrap">{formatMinor(b.projection.todayMinor, c)} today</span>
          {b.projection.inMinor > 0 && (
            <>
              {" "}
              <span className="whitespace-nowrap">
                + {formatMinor(b.projection.inMinor, c)} expected in
              </span>
            </>
          )}
          {b.projection.outMinor > 0 && (
            <>
              {" "}
              <span className="whitespace-nowrap">
                − {formatMinor(b.projection.outMinor, c)} expected out
              </span>
            </>
          )}{" "}
          <span className="whitespace-nowrap">= {money(b.endMinor)}</span>
        </p>
      )}
    </div>
  );
}

/** What the figures are made of, folded away until asked for. */
function HowCalculated({ s }: { s: PeriodSummary }) {
  const b = s.balance;
  const names = (list: Array<{ name: string; type: string }>) =>
    list
      .map(
        (a) => `${a.name} (${a.type === "credit" ? "card" : a.type === "loan" ? "loan" : "cash"})`,
      )
      .join(", ");
  return (
    <details className="text-xs text-slate-500 dark:text-slate-400">
      <summary className="cursor-pointer">How this is calculated</summary>
      <div className="mt-1 space-y-1">
        <p>
          Cash is your bank and cash accounts; card debt is what is owed on your credit cards; cash
          minus cards is the first less the second. Loans and investments are left out.
        </p>
        <p>
          A past day is worked out from today&apos;s balance and the posted transactions since, so
          it is only as good as the history the app has. A future day adds what is still expected:
          planned items and pending manual entries. A pending card purchase adds to card debt and
          leaves cash alone until the bill is paid.
        </p>
        <p>
          Money in and out leave out moves between your own accounts and payments toward cards or
          loans, which is why they can differ from the change in balance.
        </p>
        {b.accounts.length > 0 && <p>Counted: {names(b.accounts)}.</p>}
        {b.withoutBalance.length > 0 && (
          <p>Left out, no balance known yet: {names(b.withoutBalance)}.</p>
        )}
      </div>
    </details>
  );
}

/** The Transactions page, showing these days, this account and this date basis. */
function transactionsLink(span: DaySpan, accountId: string, basis: string): string {
  const q = new URLSearchParams({ from: span.from, to: span.to });
  if (accountId) q.set("account", accountId);
  if (basis === "posted") q.set("dateBasis", "posted");
  return `/transactions?${q}`;
}

function TransactionList({
  span,
  accountId,
  onOpenTransaction,
  onShowTable,
}: {
  span: DaySpan;
  accountId: string;
  /** Opens one transaction's details. */
  onOpenTransaction: (t: Transaction) => void;
  /** Opens the table of these days' transactions. */
  onShowTable: () => void;
}) {
  const basis = useDateBasis();
  const query = new URLSearchParams({
    from: span.from,
    to: span.to,
    pageSize: String(TX_LIMIT),
    sort: isSingleDay(span) ? "amount_asc" : basis === "posted" ? "date_desc" : "txdate_desc",
    dateBasis: basis,
  });
  if (accountId) query.set("accountId", accountId);
  const list = usePagedTransactions(query);
  const single = isSingleDay(span);

  return (
    <div>
      {list.error && (
        <p role="alert" className="text-sm text-red-600">
          {list.error}
        </p>
      )}
      {list.loading && <Loading />}
      {list.items && list.items.length === 0 && (
        <p className="text-sm text-slate-500">
          No transactions {single ? "on this day" : "in this span"}.
        </p>
      )}
      {list.items && list.items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 text-xs">
          <button type="button" className={smallButton} onClick={onShowTable}>
            View all as a table
          </button>
          <Link
            to={transactionsLink(span, accountId, basis)}
            className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
          >
            Open in Transactions
          </Link>
        </div>
      )}
      <ul className="space-y-1">
        {list.items?.map((t) => (
          <li key={t.id} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: t.accountColor ?? "#94a3b8" }}
                />
                <button
                  type="button"
                  className="truncate text-left hover:underline"
                  title="Open this transaction"
                  onClick={() => onOpenTransaction(t)}
                >
                  {t.merchant}
                </button>
                {t.pending && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 text-xs text-amber-900">
                    Pending
                  </span>
                )}
              </span>
              <span
                className={`shrink-0 tabular-nums ${t.amountMinor < 0 ? "font-medium text-green-700 dark:text-green-400" : ""}`}
              >
                {t.amountMinor < 0 ? "+" : ""}
                {formatMinor(-t.amountMinor, t.currency)}
              </span>
            </div>
            <div className="truncate pl-[1.125rem] text-xs text-slate-500">
              {!single && `${formatDay(t.date)} · `}
              {t.accountName}
              {t.amountMinor > 0 && t.recipient ? ` · to ${t.recipient}` : ""}
              {t.amountMinor < 0 && t.sender ? ` · from ${t.sender}` : ""}
            </div>
          </li>
        ))}
      </ul>
      {list.items && (
        <LoadMore
          shown={list.items.length}
          total={list.total}
          busy={list.loadingMore}
          onMore={() => void list.loadMore()}
        />
      )}
    </div>
  );
}

/** "Planned" or "Pending manual", so it is clear where an expected item comes from. */
function SourceBadge({ source }: { source: CalendarEvent["source"] }) {
  return source === "planned" ? (
    <span className="rounded-full bg-violet-100 px-2 text-xs text-violet-900 dark:bg-violet-950 dark:text-violet-200">
      Planned
    </span>
  ) : (
    <span className="rounded-full bg-sky-100 px-2 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-200">
      Pending manual
    </span>
  );
}

type EventAction = "skip" | "done" | "undo" | "record" | "post" | "open";

function EventRow({
  e,
  today,
  busy,
  onAct,
  onEditSeries,
  onNotice,
}: {
  e: CalendarEvent;
  today: string;
  busy: boolean;
  onAct: (e: CalendarEvent, action: EventAction) => void;
  onEditSeries: (e: CalendarEvent) => void;
  onNotice: (n: { kind: "info" | "error"; text: string }) => void;
}) {
  const [changing, setChanging] = useState(false);
  const moved = e.source === "planned" && e.originalDate !== e.date;
  const overdue = e.source === "planned" && e.status === "expected" && e.date < today;
  const carried = e.source === "pending" && e.originalDate !== e.date;
  return (
    <li className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{e.merchant}</span>
            <SourceBadge source={e.source} />
            {e.status !== "expected" && (
              <span className="rounded-full bg-slate-200 px-2 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                {e.status === "done" ? "Done" : "Skipped"}
              </span>
            )}
            {overdue && (
              <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-900">
                Past due
              </span>
            )}
            {e.changed && (
              <span className="rounded-full bg-slate-200 px-2 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                Changed for this one
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {carried
              ? `Entered ${formatDay(e.originalDate)}; still pending; projected ${formatDay(e.date)}`
              : moved
                ? `${formatDay(e.date)} (moved from ${formatDay(e.originalDate)})`
                : formatDay(e.date)}
            {e.accountName ? ` · ${e.accountName}` : " · any account"}
            {e.recurring && e.repeats ? ` · ${e.repeats}` : ""}
            {e.person ? ` · ${e.direction === "out" ? "to" : "from"} ${e.person}` : ""}
          </div>
        </div>
        <span
          className={`shrink-0 tabular-nums ${e.direction === "in" ? "font-medium text-green-700 dark:text-green-400" : ""}`}
        >
          {e.direction === "in" ? "+" : "−"}
          {formatMinor(e.amountMinor, "USD")}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {e.source === "pending" ? (
          <>
            <button
              type="button"
              className={smallButton}
              disabled={busy}
              onClick={() => onAct(e, "open")}
            >
              Open
            </button>
            <button
              type="button"
              className={smallButton}
              disabled={busy}
              onClick={() => onAct(e, "post")}
              title="It has gone through: count it in the balance from its date"
            >
              Mark posted
            </button>
          </>
        ) : (
          <>
            {e.status === "expected" ? (
              <>
                {e.canRecord && (
                  <button
                    type="button"
                    className={smallButton}
                    disabled={busy}
                    onClick={() => onAct(e, "record")}
                    title="Add it as a real transaction on its account"
                  >
                    Record it
                  </button>
                )}
                <button
                  type="button"
                  className={smallButton}
                  disabled={busy}
                  onClick={() => onAct(e, "done")}
                  title="Stop expecting it; this does not add a transaction"
                >
                  Mark done
                </button>
                <button
                  type="button"
                  className={smallButton}
                  disabled={busy}
                  onClick={() => onAct(e, "skip")}
                >
                  Skip this one
                </button>
                <button
                  type="button"
                  className={smallButton}
                  disabled={busy}
                  aria-expanded={changing}
                  onClick={() => setChanging((c) => !c)}
                  title="Another day or amount for this one only; the series stays"
                >
                  Change this one
                </button>
              </>
            ) : (
              <button
                type="button"
                className={smallButton}
                disabled={busy}
                onClick={() => onAct(e, "undo")}
              >
                Expect it again
              </button>
            )}
            <button
              type="button"
              className={smallButton}
              disabled={busy}
              onClick={() => onEditSeries(e)}
            >
              {e.recurring ? "Edit series" : "Edit"}
            </button>
          </>
        )}
      </div>
      {changing && (
        <ChangeOccurrenceForm e={e} onDone={() => setChanging(false)} onNotice={onNotice} />
      )}
    </li>
  );
}

/**
 * What is still expected in the chosen days (planned items and pending manual entries, the same
 * ones the Expected count adds up), then those already done or skipped.
 */
function ExpectedList({
  span,
  accountId,
  accounts,
  today,
  onEditSeries,
  onOpenTransaction,
  onNotice,
}: {
  span: DaySpan;
  accountId: string;
  accounts: Account[];
  today: string;
  onEditSeries: (plannedId: number) => void;
  onOpenTransaction: (id: number) => void;
  onNotice: (n: { kind: "info" | "error"; text: string }) => void;
}) {
  const query = new URLSearchParams({ from: span.from, to: span.to, includeResolved: "1" });
  if (accountId) query.set("accountId", accountId);
  const { data, error, loading } = useApi<CalendarEvent[]>(`/calendar/expected?${query}`);
  const [busy, setBusy] = useState(false);
  const open = data?.filter((e) => e.status === "expected") ?? [];
  const resolved = data?.filter((e) => e.status !== "expected") ?? [];

  async function act(e: CalendarEvent, action: EventAction): Promise<void> {
    if (action === "open") {
      onOpenTransaction(e.transactionId!);
      return;
    }
    setBusy(true);
    try {
      if (action === "post") {
        await api(`/transactions/${e.transactionId}`, {
          method: "PATCH",
          body: JSON.stringify({ pending: false }),
        });
        onNotice({ kind: "info", text: `${e.merchant} is posted now.` });
      } else if (action === "record") {
        await api(`/planned/${e.plannedId}/occurrences/${e.originalDate}/record`, {
          method: "POST",
        });
        onNotice({ kind: "info", text: `${e.merchant} was recorded as a transaction.` });
      } else {
        await api(`/planned/${e.plannedId}/occurrences/${e.originalDate}`, {
          method: "PUT",
          body: JSON.stringify({
            status: action === "skip" ? "skipped" : action === "done" ? "done" : "expected",
          }),
        });
      }
      announceDataChanged();
    } catch (err) {
      onNotice({ kind: "error", text: errorMessage(err, "Could not change that item.") });
    } finally {
      setBusy(false);
    }
  }

  const row = (e: CalendarEvent) => (
    <EventRow
      key={e.id}
      e={e}
      today={today}
      busy={busy}
      onAct={(item, action) => void act(item, action)}
      onEditSeries={(item) => onEditSeries(item.plannedId!)}
      onNotice={onNotice}
    />
  );

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <QuickAddExpected
        day={span.from}
        accountId={accountId}
        accounts={accounts}
        onNotice={onNotice}
      />
      {loading && <Loading />}
      {data && open.length === 0 && (
        <p className="text-sm text-slate-500">
          Nothing still expected {isSingleDay(span) ? "on this day" : "in this span"}.
        </p>
      )}
      {open.length > 0 && <ul className="space-y-2">{open.map(row)}</ul>}
      {resolved.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">
            Done or skipped ({resolved.length})
          </summary>
          <ul className="mt-2 space-y-2">{resolved.map(row)}</ul>
        </details>
      )}
      {open.some((e) => e.source === "planned") && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Mark done stops expecting it without adding a transaction; Record it adds one to an
          account you keep by hand. Change this one moves or re-prices one occurrence; Edit series
          changes all of them.
        </p>
      )}
    </div>
  );
}

/**
 * Everything about the chosen day or span of days: the balance, what changed, the transactions,
 * a note, and what is expected, with buttons to add a transaction or an expected one.
 */
export function DayPanel({
  span,
  accountId,
  accounts,
  categories,
  today,
  showForecast,
  lowCash,
  onClear,
  onPickDay,
}: {
  span: DaySpan;
  accountId: string;
  accounts: Account[];
  categories: Category[];
  today: string;
  /** The cash forecast is shown (all accounts, Forecast on). */
  showForecast: boolean;
  lowCash: number;
  onClear: () => void;
  /** Called with a day to look at just that day (from the list of notes in a span). */
  onPickDay: (day: string) => void;
}) {
  const single = isSingleDay(span);
  // A tab the user picks stays picked while they move between days like it (past or future).
  const future = span.from > today;
  const [chosen, setChosen] = useState<{ tab: Tab; future: boolean } | null>(null);
  const setTab = (next: Tab) => setChosen({ tab: next, future });
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [detailTx, setDetailTx] = useState<Transaction | null>(null);
  const [splitting, setSplitting] = useState<Transaction | null>(null);
  /** One transaction: entered by hand opens its editor; from a bank, its details. */
  const openTx = (t: Transaction) => (t.source === "manual" ? setEditingTx(t) : setDetailTx(t));
  const [showTable, setShowTable] = useState(false);
  const [planning, setPlanning] = useState<PlannedItem | "new" | null>(null);

  const basis = useDateBasis();
  const query = new URLSearchParams({ from: span.from, to: span.to, dateBasis: basis });
  if (accountId) query.set("accountId", accountId);
  const summary = useApi<PeriodSummary>(`/calendar/summary?${query}`);
  const handAccounts = accounts.filter(
    (a) => a.isManual && (a.type === "depository" || a.type === "credit" || a.type === "loan"),
  );

  // A new selection starts with no leftover message.
  useEffect(() => setNotice(null), [span.from, span.to]);

  async function editSeries(plannedId: number): Promise<void> {
    try {
      setPlanning(await api<PlannedItem>(`/planned/${plannedId}`));
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not open that item.") });
    }
  }

  async function openTransaction(id: number): Promise<void> {
    try {
      openTx(await api<Transaction>(`/transactions/${id}`));
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not open that transaction.") });
    }
  }

  const ids = useId();
  const s = summary.data;
  // A future day with something expected opens on what is expected.
  const fitting: Tab = future && (s?.expected.count ?? 0) > 0 ? "expected" : "transactions";
  const tab = chosen && chosen.future === future ? chosen.tab : fitting;
  const note = single ? (s?.notes[0]?.note ?? null) : null;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "transactions", label: s ? `Transactions (${s.transactionCount})` : "Transactions" },
    { id: "notes", label: s && s.notes.length > 0 ? `Notes (${s.notes.length})` : "Notes" },
    {
      id: "expected",
      label: s && s.expected.count > 0 ? `Expected (${s.expected.count})` : "Expected",
    },
  ];

  function tabKeys(e: KeyboardEvent<HTMLButtonElement>): void {
    const order = tabs.map((t) => t.id);
    const at = order.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? order[(at + 1) % order.length]
        : e.key === "ArrowLeft"
          ? order[(at - 1 + order.length) % order.length]
          : e.key === "Home"
            ? order[0]
            : e.key === "End"
              ? order[order.length - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`${ids}-tab-${next}`)?.focus());
  }

  return (
    <aside
      aria-label="Selected days"
      data-keep-selection
      className="flex flex-col rounded-lg border border-slate-200 bg-white lg:min-h-0 lg:overflow-hidden dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{spanTitle(span)}</h2>
          {note && (
            <button
              type="button"
              onClick={() => setTab("notes")}
              title="Open the note"
              className="mt-0.5 block max-w-full truncate text-left text-xs text-slate-500 hover:underline dark:text-slate-400"
            >
              Note: {note}
            </button>
          )}
        </div>
        <button
          type="button"
          className={smallButton}
          onClick={onClear}
          aria-label="Clear selection"
        >
          Clear
        </button>
      </div>

      <div className="flex flex-col gap-3 px-4 pt-3 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {summary.error && (
          <p role="alert" className="text-sm text-red-600">
            {summary.error}
          </p>
        )}
        {summary.loading && <Loading />}
        {s && <BalanceFigures s={s} single={single} />}
        {single && future && showForecast && (
          <ForecastSection day={span.from} lowCash={lowCash} onNotice={setNotice} />
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primaryClass}
            onClick={() => setAdding(true)}
            disabled={handAccounts.length === 0}
          >
            Add transaction
          </button>
          <button type="button" className={buttonClass} onClick={() => setPlanning("new")}>
            Add expected transaction
          </button>
        </div>
        {handAccounts.length === 0 && (
          <p className="text-xs text-slate-500">
            To add a transaction by hand, first{" "}
            <Link to="/accounts" className="text-blue-600 underline">
              add an account you keep by hand
            </Link>{" "}
            (a Cash account, for example). Expected transactions work with any account.
          </p>
        )}

        {notice && (
          <p
            role={notice.kind === "error" ? "alert" : "status"}
            className={`rounded-md border px-3 py-2 text-sm ${
              notice.kind === "error"
                ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
                : "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
            }`}
          >
            {notice.text}
          </p>
        )}

        {s && <MoreFigures s={s} single={single} />}

        <div
          role="tablist"
          aria-label="Details"
          className="sticky top-0 z-10 -mx-4 flex gap-1 border-b border-slate-200 bg-white px-4 pt-1 dark:border-slate-700 dark:bg-slate-900"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              id={`${ids}-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`${ids}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={tabKeys}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t.id
                  ? "border-blue-600 font-medium text-blue-700 dark:text-blue-400"
                  : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`${ids}-panel`}
          aria-labelledby={`${ids}-tab-${tab}`}
          tabIndex={0}
          className="rounded outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {tab === "transactions" && (
            <TransactionList
              span={span}
              accountId={accountId}
              onOpenTransaction={openTx}
              onShowTable={() => setShowTable(true)}
            />
          )}
          {tab === "notes" &&
            (single ? (
              s ? (
                <NoteBox
                  key={span.from}
                  day={span.from}
                  saved={note ?? ""}
                  placeholder="Anything you want to remember about this day"
                />
              ) : null
            ) : s && s.notes.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {s.notes.map((n) => (
                  <li key={n.date}>
                    <button
                      type="button"
                      className="font-medium text-blue-700 hover:underline dark:text-blue-400"
                      onClick={() => onPickDay(n.date)}
                    >
                      {formatDay(n.date)}
                    </button>
                    <p className="whitespace-pre-wrap">{n.note}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">
                No notes in this span. Choose a single day to write one.
              </p>
            ))}
          {tab === "expected" && (
            <ExpectedList
              accounts={accounts}
              span={span}
              accountId={accountId}
              today={today}
              onEditSeries={(id) => void editSeries(id)}
              onOpenTransaction={(id) => void openTransaction(id)}
              onNotice={setNotice}
            />
          )}
        </div>
      </div>

      {adding && (
        <ManualTransactionDialog
          accounts={handAccounts}
          categories={categories}
          defaultAccountId={accountId ? Number(accountId) : undefined}
          defaultDate={span.from}
          onSaved={(message) => {
            setAdding(false);
            setNotice({ kind: "info", text: message });
            setTab("transactions");
            announceDataChanged();
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {showTable && (
        <DayTransactionsTable
          span={span}
          accountId={accountId}
          onOpen={(t) => {
            setShowTable(false);
            openTx(t);
          }}
          onClose={() => setShowTable(false)}
        />
      )}
      {editingTx && (
        <ManualTransactionDialog
          accounts={handAccounts}
          categories={categories}
          transaction={editingTx}
          onSaved={(message) => {
            setEditingTx(null);
            setNotice({ kind: "info", text: message });
            announceDataChanged();
          }}
          onClose={() => setEditingTx(null)}
          onSplit={() => {
            setSplitting(editingTx);
            setEditingTx(null);
          }}
        />
      )}
      {detailTx && (
        <TransactionDetail
          transaction={detailTx}
          categories={categories}
          onClose={() => setDetailTx(null)}
          onSplit={() => {
            setSplitting(detailTx);
            setDetailTx(null);
          }}
          onSaved={(updated, rule) => {
            setDetailTx(null);
            setNotice({
              kind: "info",
              text: rule
                ? `Rule “${rule.name}” created. ${rule.changed} transaction${rule.changed === 1 ? "" : "s"} recategorized.`
                : `${updated.merchant} was saved.`,
            });
            announceDataChanged();
          }}
        />
      )}
      {splitting && (
        <SplitDialog
          transaction={splitting}
          categories={categories}
          onClose={() => setSplitting(null)}
          onSaved={(updated) => {
            setSplitting(null);
            setNotice({
              kind: "info",
              text:
                updated.splits.length > 0
                  ? `${updated.merchant} is split across ${updated.splits.length} categories.`
                  : `${updated.merchant} is no longer split.`,
            });
            announceDataChanged();
          }}
        />
      )}
      {planning && (
        <PlannedDialog
          accounts={accounts}
          categories={categories}
          defaultDate={span.from}
          defaultAccountId={accountId ? Number(accountId) : undefined}
          planned={planning === "new" ? undefined : planning}
          onSaved={(message) => {
            setPlanning(null);
            setNotice({ kind: "info", text: message });
            setTab("expected");
            announceDataChanged();
          }}
          onClose={() => setPlanning(null)}
        />
      )}
    </aside>
  );
}
