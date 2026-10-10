import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../api/client";
import { LineChart } from "../components/charts/LineChart";
import { AccountName } from "../components/common/AccountName";
import { Modal } from "../components/common/Modal";
import { buttonClass, inputClass, primaryClass } from "../components/investments/styles";
import { useApi } from "../hooks/useApi";
import { formatAxisMoney, formatMinor, parseMoneyToMinor } from "../lib/money";
import { announceDataChanged } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import { CADENCE_LABEL } from "../lib/insights";
import type { Cadence } from "../types/insights";
import type {
  BillStatus,
  CardBill,
  Forecast,
  Paycheck,
  RecurringChange,
  Subscription,
  SubscriptionReview,
  SubscriptionStatus,
} from "../types/planning";

type Tab = "forecast" | "bills" | "subscriptions" | "paychecks";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "forecast", label: "Cash-flow forecast" },
  { id: "bills", label: "Card bills" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "paychecks", label: "Paychecks" },
];

/** Looking ahead: the cash forecast, card bills, and recurring charges to review. */
export function PlanningPage() {
  const [tab, setTab] = useState<Tab>("forecast");
  return (
    <section className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Planning</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Where your cash is heading, what your cards will ask for, and what you pay for every
          month.
        </p>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? "border-blue-600 font-medium text-blue-700 dark:text-blue-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "forecast" && <ForecastTab />}
      {tab === "bills" && <BillsTab />}
      {tab === "subscriptions" && <SubscriptionsTab />}
      {tab === "paychecks" && <PaychecksTab />}
    </section>
  );
}

// ---- Forecast ----------------------------------------------------------------------------------

const SOURCE_LABEL = { expected: "Expected", recurring: "Recurring", card_bill: "Card bill" };

function ForecastTab() {
  const [days, setDays] = useState(60);
  const { data, error, loading } = useApi<Forecast>(`/forecast?days=${days}`);
  if (error)
    return (
      <p role="alert" className="text-sm text-red-600">
        {error}
      </p>
    );
  if (!data) return <p className="text-sm text-slate-500">{loading ? "Loading..." : ""}</p>;
  const money = (n: number) => formatMinor(n, data.currency);
  const upcoming = data.days.filter((d) => d.events.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="In the bank today" value={money(data.startBalanceMinor)} />
          <Stat
            label={`Lowest (${formatDay(data.lowest.date)})`}
            value={money(data.lowest.balanceMinor)}
            warn={data.lowest.balanceMinor < 0}
          />
          <Stat label={`In ${days} days`} value={money(data.endBalanceMinor)} />
        </dl>
        <label className="text-sm">
          Look ahead{" "}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border border-slate-300 px-2 py-1 dark:border-slate-600"
          >
            {[30, 60, 90, 180].map((n) => (
              <option key={n} value={n}>
                {n} days
              </option>
            ))}
          </select>
        </label>
      </div>
      {data.lowest.balanceMinor < 0 && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          Your bank accounts are expected to go below zero on {formatDay(data.lowest.date)}.
        </p>
      )}
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <LineChart
          series={[
            {
              key: "cash",
              label: "Cash in the bank",
              color: "#2563eb",
              points: data.days.map((d) => ({ date: d.date, value: d.balanceMinor })),
            },
          ]}
          dots={false}
          format={money}
          formatAxis={formatAxisMoney}
        />
      </div>
      <p className="text-xs text-slate-500">
        From the balances of {data.accountsCounted} bank account
        {data.accountsCounted === 1 ? "" : "s"}, plus expected transactions from the calendar,
        recurring money in and out of those accounts, and card bills (for cards with their bill
        dates set). An estimate.
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="py-1 font-medium">Date</th>
            <th className="py-1 font-medium">What</th>
            <th className="py-1 text-right font-medium">Amount</th>
            <th className="py-1 text-right font-medium">Balance after</th>
          </tr>
        </thead>
        <tbody>
          {upcoming.flatMap((d) =>
            d.events.map((e, i) => (
              <tr
                key={`${d.date}-${i}`}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <td className="py-1 whitespace-nowrap">{i === 0 ? formatDay(d.date) : ""}</td>
                <td className="py-1">
                  {e.label} <span className="text-xs text-slate-400">{SOURCE_LABEL[e.source]}</span>
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${e.amountMinor > 0 ? "text-green-700 dark:text-green-400" : ""}`}
                >
                  {e.amountMinor > 0 ? "+" : ""}
                  {money(e.amountMinor)}
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${d.balanceMinor < 0 ? "text-red-600" : "text-slate-500"}`}
                >
                  {i === d.events.length - 1 ? money(d.balanceMinor) : ""}
                </td>
              </tr>
            )),
          )}
          {upcoming.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-slate-500">
                Nothing expected yet. Add expected transactions on the calendar, or set your card
                bill dates.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${warn ? "text-red-600" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

// ---- Card bills --------------------------------------------------------------------------------

const STATUS: Record<BillStatus, { text: string; className: string }> = {
  paid: { text: "Paid", className: "bg-green-100 text-green-900" },
  partial: { text: "Partly paid", className: "bg-amber-100 text-amber-900" },
  due: { text: "Due", className: "bg-blue-100 text-blue-900" },
  overdue: { text: "Overdue", className: "bg-red-100 text-red-900" },
  nothing_due: { text: "Nothing due", className: "bg-slate-200 text-slate-700" },
};

function BillsTab() {
  const bills = useApi<CardBill[]>("/bills");
  const [editing, setEditing] = useState<CardBill | null>(null);
  if (bills.error)
    return (
      <p role="alert" className="text-sm text-red-600">
        {bills.error}
      </p>
    );
  if (!bills.data) return <p className="text-sm text-slate-500">Loading...</p>;
  if (bills.data.length === 0)
    return <p className="text-sm text-slate-500">No credit cards yet.</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Set the day each card&apos;s statement closes and the day payment is due. The statement
        balance is worked out from the card&apos;s balance and the purchases since it closed, so it
        can differ a little from the bank&apos;s (interest, fees, pending charges).
      </p>
      {bills.data.map((b) => {
        const money = (n: number) => formatMinor(n, b.currency);
        const s = b.statement;
        return (
          <div
            key={b.accountId}
            className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">
                <span
                  aria-hidden="true"
                  className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: b.color ?? "#94a3b8" }}
                />
                <AccountName name={b.name} institutionName={b.institutionName} />
              </div>
              <div className="flex items-center gap-2">
                {s && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[s.status].className}`}
                  >
                    {STATUS[s.status].text}
                  </span>
                )}
                <button type="button" className={buttonClass} onClick={() => setEditing(b)}>
                  {b.settings ? "Edit dates" : "Set bill dates"}
                </button>
              </div>
            </div>
            {s ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <Info
                  label={`Statement (closed ${formatDay(s.closedOn)})`}
                  value={money(s.balanceMinor)}
                />
                <Info label="Paid since" value={money(s.paidMinor)} />
                <Info
                  label={`Left to pay by ${formatDay(s.dueOn)}`}
                  value={money(s.remainingMinor)}
                  note={
                    s.remainingMinor > 0
                      ? s.daysUntilDue >= 0
                        ? `${s.daysUntilDue} day${s.daysUntilDue === 1 ? "" : "s"} left`
                        : `${-s.daysUntilDue} days late`
                      : undefined
                  }
                />
                <Info
                  label={
                    b.next ? `Next statement (${formatDay(b.next.closesOn)})` : "Next statement"
                  }
                  value={b.next ? `${money(b.next.balanceSoFarMinor)} so far` : "—"}
                />
                {s.minimumMinor !== null && (
                  <Info label="Minimum payment" value={money(s.minimumMinor)} />
                )}
                {b.settings?.autopay && <Info label="Autopay" value="On" />}
              </dl>
            ) : (
              <p className="mt-1 text-sm text-slate-500">
                {b.settings ? "The bank has not given this card's balance." : "Bill dates not set."}{" "}
                Balance now:{" "}
                {b.currentBalanceMinor === null ? "unknown" : money(b.currentBalanceMinor)}
              </p>
            )}
          </div>
        );
      })}
      {editing && (
        <BillDialog
          bill={editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) {
              bills.reload();
              announceDataChanged();
            }
          }}
        />
      )}
    </div>
  );
}

function Info({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-medium tabular-nums">
        {value} {note && <span className="text-xs font-normal text-slate-500">({note})</span>}
      </dd>
    </div>
  );
}

function BillDialog({ bill, onClose }: { bill: CardBill; onClose: (saved: boolean) => void }) {
  const [closingDay, setClosingDay] = useState(String(bill.settings?.closingDay ?? ""));
  const [dueDay, setDueDay] = useState(String(bill.settings?.dueDay ?? ""));
  const [minimum, setMinimum] = useState(
    bill.settings?.minimumMinor != null ? (bill.settings.minimumMinor / 100).toFixed(2) : "",
  );
  const [autopay, setAutopay] = useState(bill.settings?.autopay ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    const close = Number(closingDay);
    const due = Number(dueDay);
    if (![close, due].every((d) => Number.isInteger(d) && d >= 1 && d <= 31)) {
      setError("Enter days of the month from 1 to 31.");
      return;
    }
    const minimumMinor = minimum.trim() === "" ? null : parseMoneyToMinor(minimum, bill.currency);
    if (minimum.trim() !== "" && minimumMinor === null) {
      setError("Enter the minimum payment as an amount, such as 35.00, or leave it empty.");
      return;
    }
    setBusy(true);
    try {
      await api(`/accounts/${bill.accountId}/bill`, {
        method: "PUT",
        body: JSON.stringify({ closingDay: close, dueDay: due, minimumMinor, autopay }),
      });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err, "Could not save the dates."));
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    setBusy(true);
    await api(`/accounts/${bill.accountId}/bill`, { method: "DELETE" }).catch(() => undefined);
    onClose(true);
  }

  return (
    <Modal title={`Bill dates: ${bill.name}`} onClose={() => onClose(false)}>
      <form onSubmit={(e) => void save(e)} className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            Statement closes on day
            <input
              inputMode="numeric"
              value={closingDay}
              onChange={(e) => setClosingDay(e.target.value)}
              className={inputClass}
              placeholder="25"
            />
          </label>
          <label className="block">
            Payment due on day
            <input
              inputMode="numeric"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              className={inputClass}
              placeholder="20"
            />
          </label>
        </div>
        <label className="block">
          Minimum payment (optional)
          <input
            inputMode="decimal"
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
            className={inputClass}
            placeholder="35.00"
          />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} />
          Paid automatically (autopay)
        </label>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {bill.settings && (
            <button
              type="button"
              className={`${buttonClass} mr-auto`}
              disabled={busy}
              onClick={() => void clear()}
            >
              Remove dates
            </button>
          )}
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => onClose(false)}
          >
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Subscriptions -----------------------------------------------------------------------------

const DECISIONS: Array<{ value: SubscriptionStatus | ""; label: string }> = [
  { value: "", label: "Not decided" },
  { value: "keep", label: "Keep" },
  { value: "cancel", label: "Cancel it" },
  { value: "cancelled", label: "Cancelled" },
];

function SubscriptionsTab() {
  const review = useApi<SubscriptionReview>("/subscriptions");
  const [showLapsed, setShowLapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (review.error)
    return (
      <p role="alert" className="text-sm text-red-600">
        {review.error}
      </p>
    );
  if (!review.data) return <p className="text-sm text-slate-500">Loading...</p>;
  const data = review.data;
  const money = (n: number) => formatMinor(n, data.currency);
  const shown = data.subscriptions.filter((s) => showLapsed || s.status === "active");

  async function decide(
    s: Subscription,
    status: SubscriptionStatus | "",
    note?: string,
  ): Promise<void> {
    try {
      await api(`/subscriptions/${encodeURIComponent(s.key)}`, {
        method: "PUT",
        body: JSON.stringify({
          merchant: s.merchant,
          status: status === "" ? null : status,
          note: note ?? s.review?.note ?? null,
        }),
      });
      setError(null);
      review.reload();
    } catch (e) {
      setError(errorMessage(e, "Could not save that."));
    }
  }

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Per month" value={money(data.totals.monthlyMinor)} />
        <Stat label="Per year" value={money(data.totals.yearlyMinor)} />
        <Stat label="Marked to cancel (per year)" value={money(data.totals.toCancelYearlyMinor)} />
      </dl>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <RecentChanges changes={data.changes} money={money} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showLapsed}
          onChange={(e) => setShowLapsed(e.target.checked)}
        />
        Also show ones that seem to have stopped
      </label>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="py-1 font-medium">Merchant</th>
            <th className="py-1 font-medium">How often</th>
            <th className="py-1 text-right font-medium">Usual</th>
            <th className="py-1 text-right font-medium">Per year</th>
            <th className="py-1 font-medium">Last / next</th>
            <th className="py-1 font-medium">Your decision</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.key} className="border-t border-slate-100 align-top dark:border-slate-800">
              <td className="py-1.5">
                <div className="font-medium">{s.merchant}</div>
                <div className="text-xs text-slate-500">{s.accountNames.join(", ")}</div>
                {s.priceChange && (
                  <div className="text-xs text-amber-700 dark:text-amber-400">
                    Price went from {money(s.priceChange.fromMinor)} to{" "}
                    {money(s.priceChange.toMinor)} on {formatDay(s.priceChange.date)}
                  </div>
                )}
                {s.chargedAfterCancel && (
                  <div className="text-xs font-medium text-red-600">
                    Still charged after you cancelled it
                  </div>
                )}
              </td>
              <td className="py-1.5">{CADENCE_LABEL[s.cadence as Cadence] ?? s.cadence}</td>
              <td className="py-1.5 text-right tabular-nums">
                {money(s.typicalAmountMinor)}
                {s.amountVaries && <span className="text-xs text-slate-400"> varies</span>}
              </td>
              <td className="py-1.5 text-right font-medium tabular-nums">{money(s.yearlyMinor)}</td>
              <td className="py-1.5 text-xs text-slate-500">
                {formatDay(s.lastDate)}
                <br />
                {s.status === "active"
                  ? `next ${formatDay(s.nextExpected)}`
                  : "seems to have stopped"}
              </td>
              <td className="py-1.5">
                <select
                  aria-label={`Decision for ${s.merchant}`}
                  value={s.review?.status ?? ""}
                  onChange={(e) => void decide(s, e.target.value as SubscriptionStatus | "")}
                  className="rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-600"
                >
                  {DECISIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr>
              <td colSpan={6} className="py-3 text-slate-500">
                No recurring charges found yet. They show up after a few months of history.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const CHANGE_TEXT: Record<RecurringChange["kind"], string> = {
  price_up: "Price went up",
  price_down: "Price went down",
  new: "New recurring charge",
  charged_after_cancel: "Still charged after you cancelled it",
};

/** Recent price changes, new recurring charges, and charges after cancelling, newest first. */
function RecentChanges({
  changes,
  money,
}: {
  changes: RecurringChange[];
  money: (n: number) => string;
}) {
  return (
    <section
      aria-label="What changed recently"
      className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
    >
      <h2 className="text-sm font-semibold">What changed recently</h2>
      {changes.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">
          No price changes or new recurring charges in the last few months.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {changes.map((c) => {
            const bad = c.kind === "price_up" || c.kind === "charged_after_cancel";
            return (
              <li
                key={`${c.key}-${c.kind}`}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <span>
                  <span
                    className={`mr-2 rounded-xl px-2 py-0.5 text-xs font-medium ${
                      bad
                        ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                        : c.kind === "price_down"
                          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200"
                          : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    }`}
                  >
                    {CHANGE_TEXT[c.kind]}
                  </span>
                  <span className="font-medium">{c.merchant}</span>
                  <span className="text-slate-500">
                    {" "}
                    {c.fromMinor !== null
                      ? `${money(c.fromMinor)} → ${money(c.toMinor)}`
                      : money(c.toMinor)}
                    {" · "}
                    {c.kind === "new" ? "since" : "on"} {formatDay(c.date)}
                  </span>
                </span>
                <span
                  className={`tabular-nums ${c.yearlyDeltaMinor > 0 ? "text-red-600" : "text-green-700 dark:text-green-400"}`}
                >
                  {c.yearlyDeltaMinor > 0 ? "+" : "−"}
                  {money(Math.abs(c.yearlyDeltaMinor))} a year
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- Paychecks ---------------------------------------------------------------------------------

/** Regular pay found in the income, with what it adds up to this year. */
function PaychecksTab() {
  const pay = useApi<Paycheck[]>("/paychecks");
  if (pay.error)
    return (
      <p role="alert" className="text-sm text-red-600">
        {pay.error}
      </p>
    );
  if (!pay.data) return <p className="text-sm text-slate-500">Loading...</p>;
  const money = (n: number) => formatMinor(n, "USD");
  const active = pay.data.filter((p) => p.active);
  const year = new Date().getFullYear();
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        Income that arrives on a schedule from the same source for about the same amount. The Taxes
        page uses these to estimate the year&apos;s pay.
      </p>
      {active.length > 0 && (
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <Stat
            label={`Received in ${year}`}
            value={money(active.reduce((n, p) => n + p.receivedThisYearMinor, 0))}
          />
          <Stat
            label="Paydays left this year"
            value={String(active.reduce((n, p) => n + p.paydaysLeft, 0))}
          />
          <Stat
            label={`Expected for ${year}`}
            value={money(active.reduce((n, p) => n + p.projectedYearMinor, 0))}
          />
        </dl>
      )}
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="py-1 font-medium">From</th>
            <th className="py-1 font-medium">How often</th>
            <th className="py-1 text-right font-medium">Usual</th>
            <th className="py-1 font-medium">Last / next</th>
            <th className="py-1 text-right font-medium">This year</th>
          </tr>
        </thead>
        <tbody>
          {pay.data.map((p) => (
            <tr key={p.key} className="border-t border-slate-100 align-top dark:border-slate-800">
              <td className="py-1.5">
                <div className="font-medium">{p.source}</div>
                <div className="text-xs text-slate-500">
                  {p.accountName} · {p.occurrences} paychecks seen
                </div>
              </td>
              <td className="py-1.5">{CADENCE_LABEL[p.cadence]}</td>
              <td className="py-1.5 text-right tabular-nums">{money(p.typicalMinor)}</td>
              <td className="py-1.5 text-xs text-slate-500">
                {formatDay(p.lastDate)}
                <br />
                {p.active ? `next ${formatDay(p.nextExpected)}` : "seems to have stopped"}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                <div className="font-medium">{money(p.projectedYearMinor)}</div>
                <div className="text-xs text-slate-500">
                  {money(p.receivedThisYearMinor)} so far
                  {p.paydaysLeft > 0 ? ` + ${p.paydaysLeft} more` : ""}
                </div>
              </td>
            </tr>
          ))}
          {pay.data.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-slate-500">
                No regular pay found yet. It shows up after a few paychecks from the same source.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
