import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { AccountName } from "../components/common/AccountName";
import { Modal } from "../components/common/Modal";
import { buttonClass, inputClass, primaryClass } from "../components/common/styles";
import { AnnotatedForecast } from "../components/views/AnnotatedForecast";
import { ScenarioDialog, useScenarioPickers } from "../components/views/ScenarioDialog";
import { AddWhatIfDialog, SaveWhatIfsDialog, WhatIfChips } from "../components/views/WhatIfDraft";
import type { OneOffAdjustment } from "../components/views/WhatIfForm";
import { useApi } from "../hooks/useApi";
import { usePersistentState } from "../hooks/usePersistentState";
import { formatMinor, parseMoneyToMinor } from "../lib/money";
import {
  comparisonSentence,
  describeAdjustment,
  draftName,
  MAX_WHAT_IFS,
  tileChangeText,
  unmatchedNote,
} from "../lib/scenarios";
import { announceDataChanged, useSyncFinishedCount } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import { holdBackLine, holdBackSummary, lowestTile } from "../lib/views";
import { CADENCE_LABEL } from "../lib/insights";
import type {
  BillStatus,
  CardBill,
  Forecast,
  Paycheck,
  Scenario,
  ScenarioAdjustment,
  ScenarioComparison,
} from "../types/planning";
import { Select } from "../components/common/Select";
import { Loading } from "../components/common/Loading";

/**
 * Where an old Planning link (/planning?view=bills) now goes: the page of that name, or null for
 * the forecast, which stays at /planning. Pure.
 */
export function legacyPlanningPath(view: string | null): string | null {
  if (view === "bills") return "/planning/bills";
  if (view === "paychecks") return "/planning/paychecks";
  return null;
}

/** The Cash forecast page, at /planning: the first of the Planning tabs. */
export function PlanningPage() {
  const [params] = useSearchParams();
  const moved = legacyPlanningPath(params.get("view"));
  if (moved) return <Navigate to={moved} replace />;
  return (
    <section className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Cash forecast</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Where the money in your bank accounts is heading.
        </p>
      </div>
      <ForecastView />
    </section>
  );
}

/** Each card's statement and due date. */
export function CardBillsPage() {
  return (
    <section className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Card bills</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          What each credit card will ask for, and when.
        </p>
      </div>
      <BillsView />
    </section>
  );
}

/** Regular pay, and what it adds up to this year. */
export function PaychecksPage() {
  return (
    <section className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Paychecks</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">What you are paid.</p>
      </div>
      <PaychecksView />
    </section>
  );
}

// ---- Forecast ----------------------------------------------------------------------------------

const SOURCE_LABEL = {
  expected: "Expected",
  recurring: "Recurring",
  card_bill: "Card bill",
  pending: "Pending",
  debt_plan: "Debt plan",
  interest: "Interest (from the APY)",
  goal: "Set aside for a goal",
  cap_holdback: "Spending caps (held back)",
  instalment: "Instalment payment",
  scenario: "What-if",
};

/** Where the held-back caps reach: the rest of the month, or only as far as the forecast does. */
function holdRange(f: Forecast): string {
  const [y, m] = f.today.split("-").map(Number) as [number, number];
  const end = f.days.at(-1)?.date ?? f.today;
  const monthEnd = `${f.today.slice(0, 8)}${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
  if (end < monthEnd) return `through ${formatDay(end)}, as far as this forecast reaches`;
  const month = new Date(`${f.today}T12:00:00`).toLocaleString("en-US", { month: "long" });
  return `spread over the rest of ${month}`;
}

function ForecastView() {
  const [days, setDays] = useState(60);
  const { data, error, loading, reload } = useApi<Forecast>(`/forecast?days=${days}`);
  const [holdError, setHoldError] = useState<string | null>(null);
  const scenarios = useApi<Scenario[]>("/forecast/scenarios");
  const [chosen, setChosen] = usePersistentState("pf.forecast.compare", "");
  const [managing, setManaging] = useState(false);
  // A scenario that was deleted no longer counts as chosen.
  const compareId = scenarios.data?.some((s) => String(s.id) === chosen) ? chosen : "";
  const comparison = useApi<ScenarioComparison>(
    compareId ? `/forecast/scenarios/${compareId}/compare?days=${days}` : null,
  );
  const selected = scenarios.data?.find((s) => String(s.id) === compareId) ?? null;
  // What-ifs added from the chart: not saved, and tried out through the preview.
  const [draft, setDraft] = useState<OneOffAdjustment[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ScenarioComparison | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const synced = useSyncFinishedCount();
  const combined = useMemo<ScenarioAdjustment[]>(
    () => [...(selected?.adjustments ?? []), ...draft],
    [selected, draft],
  );
  useEffect(() => {
    if (draft.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    // Typing several in a row asks once, and an answer for an older draft is thrown away.
    let stale = false;
    const timer = setTimeout(() => {
      api<ScenarioComparison>("/forecast/scenarios/preview", {
        method: "POST",
        body: JSON.stringify({ adjustments: combined, days }),
      })
        .then((result) => {
          if (stale) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (!stale) setPreviewError(errorMessage(e, "Could not work out your what-ifs."));
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [combined, days, draft.length, previewTick, synced]);
  const drafting = draft.length > 0;
  const live = drafting ? preview : compareId ? comparison.data : null;
  // With what-ifs the line is named for them (and the scenario it builds on).
  const compared =
    live && drafting
      ? {
          ...live,
          scenario: {
            ...live.scenario,
            name: draftName(selected?.name ?? null, draft.length),
          },
        }
      : live;
  const pickers = useScenarioPickers(managing || compareId !== "");
  async function holdCaps(on: boolean): Promise<void> {
    setHoldError(null);
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify({ forecastHoldCaps: on }) });
      reload();
      // The scenario line is worked out with the same hold-back, so it follows.
      comparison.reload();
      setPreviewTick((n) => n + 1);
      announceDataChanged();
    } catch (e) {
      // The box shows what the forecast says, so it stays as it was.
      setHoldError(errorMessage(e));
    }
  }
  if (error)
    return (
      <p role="alert" className="text-sm text-red-600">
        {error}
      </p>
    );
  if (!data) return loading ? <Loading lines={5} /> : null;
  const money = (n: number) => formatMinor(n, data.currency);
  // The daily cap hold-back would fill the table, so it gets one summary row below the rest.
  const upcoming = data.days
    .map((d) => ({ ...d, events: d.events.filter((e) => e.source !== "cap_holdback") }))
    .filter((d) => d.events.length > 0);
  const held = holdBackSummary(data.days);
  const low = lowestTile(data);
  const altLow = compared ? lowestTile(compared.alt) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="In the bank today" value={money(data.startBalanceMinor)} />
          <Stat
            label={`${low.afterToday ? "Lowest after today" : "Lowest"} (${formatDay(low.date)})`}
            value={money(low.balanceMinor)}
            warn={low.balanceMinor < 0}
            change={
              compared && altLow
                ? tileChangeText(altLow.balanceMinor - low.balanceMinor, data.currency)
                : undefined
            }
          />
          <Stat
            label={`In ${days} days`}
            value={money(data.endBalanceMinor)}
            change={compared ? tileChangeText(compared.endChangeMinor, data.currency) : undefined}
          />
        </dl>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label>
            Compare with{" "}
            <Select
              value={compareId}
              onChange={(e) => setChosen(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-600"
            >
              <option value="">Nothing</option>
              {(scenarios.data ?? []).map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
          <button type="button" className={buttonClass} onClick={() => setManaging(true)}>
            Scenarios...
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={draft.length >= MAX_WHAT_IFS}
            onClick={() => setAdding(true)}
          >
            Add a what-if...
          </button>
          <label>
            Look ahead{" "}
            <Select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-600"
            >
              {[30, 60, 90, 180].map((n) => (
                <option key={n} value={n}>
                  {n} days
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
      {!drafting && compareId && comparison.error && (
        <p role="alert" className="text-sm text-red-600">
          {comparison.error}
        </p>
      )}
      {drafting && previewError && (
        <p role="alert" className="text-sm text-red-600">
          {previewError}
        </p>
      )}
      {adding && (
        <AddWhatIfDialog
          currency={data.currency}
          dates={{
            min: data.days.find((d) => d.date > data.today)?.date ?? data.today,
            max: data.days.at(-1)?.date ?? data.today,
          }}
          onAdd={(a) => setDraft((d) => [...d, a])}
          onClose={() => setAdding(false)}
        />
      )}
      {saving && (
        <SaveWhatIfsDialog
          adjustments={combined}
          onSaved={(saved) => {
            setSaving(false);
            setDraft([]);
            scenarios.reload();
            setChosen(String(saved.id));
          }}
          onClose={() => setSaving(false)}
        />
      )}
      {managing && (
        <ScenarioDialog
          scenarios={scenarios.data ?? []}
          currency={data.currency}
          today={data.today}
          days={days}
          pickers={pickers}
          unmatched={
            compared
              ? {
                  scenarioId: compared.scenario.id,
                  adjustments: compared.unmatched.map((i) => compared.scenario.adjustments[i]!),
                }
              : null
          }
          onChanged={(savedId) => {
            scenarios.reload();
            // After a delete there is nothing to reload: a deleted scenario would only 404.
            if (savedId !== undefined) {
              comparison.reload();
              setChosen(String(savedId));
            }
          }}
          onClose={() => setManaging(false)}
        />
      )}
      {data.lowest.balanceMinor < 0 && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          Your bank accounts are expected to go below zero on {formatDay(data.lowest.date)}.
        </p>
      )}
      <AnnotatedForecast
        forecast={data}
        compare={compared ? { label: compared.scenario.name, days: compared.alt.days } : null}
        onAddWhatIf={draft.length < MAX_WHAT_IFS ? (a) => setDraft((d) => [...d, a]) : undefined}
        drafted={draft.map((a) => a.date)}
      />
      {drafting && (
        <div className="space-y-1">
          <WhatIfChips
            draft={draft}
            currency={data.currency}
            onRemove={(i) => setDraft((d) => d.filter((_, at) => at !== i))}
            onClear={() => setDraft([])}
            onSave={() => setSaving(true)}
          />
          {draft.length >= MAX_WHAT_IFS && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              That is the most what-ifs at once. Remove one, or save them as a scenario.
            </p>
          )}
        </div>
      )}
      {compared && (
        <div className="space-y-1 text-sm">
          <p className="text-violet-700 dark:text-violet-300">
            {comparisonSentence(compared, data.currency)}
          </p>
          {compared.scenario.skipped > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Some of this scenario&apos;s saved changes couldn&apos;t be read, so they aren&apos;t
              counted.
            </p>
          )}
          {compared.unmatched.map((i) => (
            <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
              {describeAdjustment(compared.scenario.adjustments[i]!, data.currency, pickers.names)}:{" "}
              {unmatchedNote(compared.scenario.adjustments[i]!, data.today, days)}
            </p>
          ))}
        </div>
      )}
      <div className="text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={data.capHoldBack.included}
            onChange={(e) => void holdCaps(e.target.checked)}
          />
          Hold back the rest of this month&apos;s spending caps
        </label>
        {data.capHoldBack.included && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {data.capHoldBack.caps.length === 0
              ? "Nothing to hold back: no cap has money left that is not already forecast."
              : `${money(data.capHoldBack.totalMinor)} held back across ${data.capHoldBack.caps.length} cap${data.capHoldBack.caps.length === 1 ? "" : "s"}, ${holdRange(data)}.`}
          </p>
        )}
        {holdError && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {holdError}
          </p>
        )}
      </div>
      <p className="text-xs text-slate-500">
        From the balances of {data.accountsCounted} bank account
        {data.accountsCounted === 1 ? "" : "s"}, plus expected transactions from the calendar,
        recurring money in and out, and card bills (for cards with their bill dates set). Upcoming
        charges to such a card, subscriptions among them, count on the day their bill is due.
        Interest counts at the end of each month for bank accounts with an APY set (under
        &quot;More...&quot; on the account). An estimate.
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
                  {e.label}{" "}
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {SOURCE_LABEL[e.source]}
                    {e.card !== undefined && e.chargedOn !== undefined
                      ? ` · charged to ${e.card} ${formatDay(e.chargedOn)}, paid with its bill`
                      : ""}
                  </span>
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
          {held && (
            <tr className="border-t border-slate-100 dark:border-slate-800">
              <td colSpan={2} className="py-1 text-slate-600 dark:text-slate-300">
                {holdBackLine(held, money)}
              </td>
              <td className="py-1 text-right tabular-nums">{money(-held.totalMinor)}</td>
              <td />
            </tr>
          )}
          {upcoming.length === 0 && !held && (
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

function Stat({
  label,
  value,
  warn,
  change,
}: {
  label: string;
  value: string;
  warn?: boolean;
  /** How a compared scenario differs, shown under the value. */
  change?: string | undefined;
}) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${warn ? "text-red-600" : ""}`}>
        {value}
      </dd>
      {change && <dd className="text-xs text-violet-700 dark:text-violet-300">{change}</dd>}
    </div>
  );
}

// ---- Card bills --------------------------------------------------------------------------------

const STATUS: Record<BillStatus, { text: string; className: string }> = {
  paid: {
    text: "Paid",
    className: "bg-green-100 text-green-900 dark:bg-green-950/60 dark:text-green-200",
  },
  partial: {
    text: "Partly paid",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  },
  due: {
    text: "Due",
    className: "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200",
  },
  overdue: {
    text: "Overdue",
    className: "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200",
  },
  nothing_due: { text: "Nothing due", className: "bg-slate-200 text-slate-700" },
};

function BillsView() {
  const bills = useApi<CardBill[]>("/bills");
  const [editing, setEditing] = useState<CardBill | null>(null);
  if (bills.error)
    return (
      <p role="alert" className="text-sm text-red-600">
        {bills.error}
      </p>
    );
  if (!bills.data) return <Loading />;
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

// ---- Paychecks ---------------------------------------------------------------------------------

/** Regular pay found in the income, with what it adds up to this year. */
function PaychecksView() {
  const pay = useApi<Paycheck[]>("/paychecks");
  if (pay.error)
    return (
      <p role="alert" className="text-sm text-red-600">
        {pay.error}
      </p>
    );
  if (!pay.data) return <Loading />;
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
