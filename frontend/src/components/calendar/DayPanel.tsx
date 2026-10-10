import { useEffect, useState } from "react";
import { useDateBasis } from "../../hooks/useDateBasis";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { Account, Category, Transaction, TransactionPage } from "../../types/api";
import type { PeriodSummary, PlannedItem, PlannedOccurrence } from "../../types/calendar";
import { ManualTransactionDialog } from "../transactions/ManualTransactionDialog";
import { buttonClass, primaryClass } from "../investments/styles";
import { DayTransactionsTable } from "./DayTransactionsTable";
import { NoteBox } from "./NoteBox";
import { PlannedDialog } from "./PlannedDialog";
import { isSingleDay, spanTitle, type DaySpan } from "./range";

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

function SummaryFigures({ s, single }: { s: PeriodSummary; single: boolean }) {
  const c = s.currency;
  const b = s.balance;
  const money = (v: number | null): string => (v === null ? "Not known" : formatMinor(v, c));
  const change = b.changeMinor;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {single ? (
          <Figure
            label={b.projected ? "Total balance (projected)" : "Total balance"}
            value={money(b.endMinor)}
            hint="at the end of the day"
          />
        ) : (
          <>
            <Figure label="Balance at start" value={money(b.startMinor)} />
            <Figure
              label={b.projected ? "Balance at end (projected)" : "Balance at end"}
              value={money(b.endMinor)}
            />
          </>
        )}
        <Figure
          label="Change in balance"
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
              label={b.projected ? "Debt owed (projected)" : "Debt owed"}
              value={s.debt.endMinor === null ? "Not known" : formatMinor(s.debt.endMinor, c)}
              hint="at the end"
            />
            <Figure
              label="Change in debt"
              value={s.debt.changeMinor === null ? "Not known" : signedMoney(s.debt.changeMinor, c)}
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
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The balance covers your cash accounts and cards, worked out from today&apos;s balance and
        the transactions the app has.
        {b.accountsWithoutBalance > 0 &&
          ` ${b.accountsWithoutBalance} account${b.accountsWithoutBalance === 1 ? " has" : "s have"} no balance yet and ${b.accountsWithoutBalance === 1 ? "is" : "are"} left out.`}
        {b.accountsCounted === 0 && " There is no account with a known balance to work from."}
      </p>
    </div>
  );
}

function TransactionList({
  span,
  accountId,
  onOpen,
}: {
  span: DaySpan;
  accountId: string;
  /** Opens the table of these days' transactions. */
  onOpen: () => void;
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
  const { data, error, loading } = useApi<TransactionPage>(`/transactions?${query}`);
  const single = isSingleDay(span);

  return (
    <div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && data.items.length === 0 && (
        <p className="text-sm text-slate-500">
          No transactions {single ? "on this day" : "in this span"}.
        </p>
      )}
      <ul className="space-y-1">
        {data?.items.map((t) => (
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
                  title="Show these days' transactions as a table"
                  onClick={onOpen}
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
      {data && data.total > data.items.length && (
        <p className="mt-1 text-xs text-slate-500">
          Showing the first {data.items.length} of {data.total}. Use the Transactions page for the
          rest.
        </p>
      )}
    </div>
  );
}

function OccurrenceRow({
  o,
  today,
  busy,
  onAct,
  onEditSeries,
}: {
  o: PlannedOccurrence;
  today: string;
  busy: boolean;
  onAct: (o: PlannedOccurrence, action: "skip" | "done" | "undo" | "record") => void;
  onEditSeries: (o: PlannedOccurrence) => void;
}) {
  const overdue = o.status === "expected" && o.date < today;
  return (
    <li className="rounded-md border border-slate-200 p-2 text-sm dark:border-slate-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{o.merchant}</span>
            {o.status !== "expected" && (
              <span className="rounded-full bg-slate-200 px-2 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                {o.status === "done" ? "Done" : "Skipped"}
              </span>
            )}
            {overdue && (
              <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-900">
                Past due
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {formatDay(o.date)}
            {o.accountName ? ` · ${o.accountName}` : " · any account"}
            {o.recurring ? ` · ${o.repeats}` : ""}
            {o.person ? ` · ${o.direction === "out" ? "to" : "from"} ${o.person}` : ""}
          </div>
        </div>
        <span
          className={`shrink-0 tabular-nums ${o.direction === "in" ? "font-medium text-green-700 dark:text-green-400" : ""}`}
        >
          {o.direction === "in" ? "+" : ""}
          {formatMinor(o.amountMinor, "USD")}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {o.status === "expected" ? (
          <>
            {o.canRecord && (
              <button
                type="button"
                className={smallButton}
                disabled={busy}
                onClick={() => onAct(o, "record")}
                title="Add it as a real transaction on its account"
              >
                Record it
              </button>
            )}
            <button
              type="button"
              className={smallButton}
              disabled={busy}
              onClick={() => onAct(o, "done")}
            >
              Mark done
            </button>
            <button
              type="button"
              className={smallButton}
              disabled={busy}
              onClick={() => onAct(o, "skip")}
            >
              Skip this one
            </button>
          </>
        ) : (
          <button
            type="button"
            className={smallButton}
            disabled={busy}
            onClick={() => onAct(o, "undo")}
          >
            Expect it again
          </button>
        )}
        <button
          type="button"
          className={smallButton}
          disabled={busy}
          onClick={() => onEditSeries(o)}
        >
          {o.recurring ? "Edit series" : "Edit"}
        </button>
      </div>
    </li>
  );
}

function ExpectedList({
  span,
  accountId,
  today,
  onEditSeries,
  onNotice,
}: {
  span: DaySpan;
  accountId: string;
  today: string;
  onEditSeries: (plannedId: number) => void;
  onNotice: (n: { kind: "info" | "error"; text: string }) => void;
}) {
  const query = new URLSearchParams({ from: span.from, to: span.to, includeResolved: "1" });
  if (accountId) query.set("accountId", accountId);
  const { data, error, loading } = useApi<PlannedOccurrence[]>(`/planned/occurrences?${query}`);
  const [busy, setBusy] = useState(false);

  async function act(
    o: PlannedOccurrence,
    action: "skip" | "done" | "undo" | "record",
  ): Promise<void> {
    setBusy(true);
    try {
      if (action === "record") {
        await api(`/planned/${o.plannedId}/occurrences/${o.date}/record`, { method: "POST" });
        onNotice({ kind: "info", text: `${o.merchant} was recorded as a transaction.` });
      } else {
        await api(`/planned/${o.plannedId}/occurrences/${o.date}`, {
          method: "PUT",
          body: JSON.stringify({
            status: action === "skip" ? "skipped" : action === "done" ? "done" : "expected",
          }),
        });
      }
      announceDataChanged();
    } catch (e) {
      onNotice({ kind: "error", text: errorMessage(e, "Could not change that item.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {data && data.length === 0 && (
        <p className="text-sm text-slate-500">
          Nothing expected {isSingleDay(span) ? "on this day" : "in this span"}.
        </p>
      )}
      <ul className="space-y-2">
        {data?.map((o) => (
          <OccurrenceRow
            key={`${o.plannedId}-${o.date}`}
            o={o}
            today={today}
            busy={busy}
            onAct={(item, action) => void act(item, action)}
            onEditSeries={(item) => onEditSeries(item.plannedId)}
          />
        ))}
      </ul>
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
  onClear,
  onPickDay,
}: {
  span: DaySpan;
  accountId: string;
  accounts: Account[];
  categories: Category[];
  today: string;
  onClear: () => void;
  /** Called with a day to look at just that day (from the list of notes in a span). */
  onPickDay: (day: string) => void;
}) {
  const single = isSingleDay(span);
  const [tab, setTab] = useState<Tab>("transactions");
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [planning, setPlanning] = useState<PlannedItem | "new" | null>(null);

  const basis = useDateBasis();
  const query = new URLSearchParams({ from: span.from, to: span.to, dateBasis: basis });
  if (accountId) query.set("accountId", accountId);
  const summary = useApi<PeriodSummary>(`/calendar/summary?${query}`);
  const handAccounts = accounts.filter(
    (a) => a.isManual && (a.type === "depository" || a.type === "credit"),
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

  const s = summary.data;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "transactions", label: s ? `Transactions (${s.transactionCount})` : "Transactions" },
    { id: "notes", label: s && s.notes.length > 0 ? `Notes (${s.notes.length})` : "Notes" },
    {
      id: "expected",
      label: s && s.expected.count > 0 ? `Expected (${s.expected.count})` : "Expected",
    },
  ];

  return (
    <aside
      aria-label="Selected days"
      data-keep-selection
      className="flex flex-col gap-3 rounded-lg lg:min-h-0 lg:overflow-y-auto border border-slate-200 p-4 dark:border-slate-700"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold">{spanTitle(span)}</h2>
        <button
          type="button"
          className={smallButton}
          onClick={onClear}
          aria-label="Clear selection"
        >
          Clear
        </button>
      </div>

      {summary.error && (
        <p role="alert" className="text-sm text-red-600">
          {summary.error}
        </p>
      )}
      {summary.loading && <p className="text-sm text-slate-500">Loading...</p>}
      {s && <SummaryFigures s={s} single={single} />}

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

      {single && s?.notes[0] && <NoteBox key={span.from} day={span.from} saved={s.notes[0].note} />}

      <div
        role="tablist"
        aria-label="Details"
        className="flex gap-1 border-b border-slate-200 dark:border-slate-700"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
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

      <div role="tabpanel">
        {tab === "transactions" && (
          <TransactionList span={span} accountId={accountId} onOpen={() => setShowTable(true)} />
        )}
        {tab === "notes" &&
          (single ? (
            s?.notes[0] ? (
              <p className="text-sm text-slate-500">Your note for this day is in the box above.</p>
            ) : (
              <NoteBox
                key={span.from}
                day={span.from}
                saved=""
                placeholder="Anything you want to remember about this day"
              />
            )
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
            span={span}
            accountId={accountId}
            today={today}
            onEditSeries={(id) => void editSeries(id)}
            onNotice={setNotice}
          />
        )}
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
          onEdit={(t) => {
            setShowTable(false);
            setEditingTx(t);
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
