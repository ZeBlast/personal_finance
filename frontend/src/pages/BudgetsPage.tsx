import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { CapHistoryChart, CapMeter, CapStatusLabel } from "../components/charts/CapMeter";
import { ConfirmDialog, Modal } from "../components/common/Modal";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import { useApi } from "../hooks/useApi";
import {
  capDetail,
  capReading,
  daysLeftIn,
  sortCaps,
  suggestedCap,
  totalExpected,
} from "../lib/caps";
import { announceDataChanged } from "../lib/syncEvents";
import { currencyDigits, formatMinor, parseMoneyToMinor } from "../lib/money";
import { firstOfMonth, lastOfMonth, monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import { formatDay } from "../lib/time";
import type { Budget, BudgetMonth, UncappedCategory } from "../types/analytics";
import { Select } from "../components/common/Select";
import { Loading } from "../components/common/Loading";

const inputClass =
  "mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";
const buttonClass =
  "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";
const primaryClass =
  "rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60";

const editableAmount = (minor: number): string => (minor / 100).toFixed(currencyDigits("USD"));

function BudgetForm({
  month,
  existing,
  budget,
  preset,
  onSaved,
  onCancel,
}: {
  month: string;
  /** Categories that already have a cap this month (not offered again when adding). */
  existing: Set<number>;
  /** Set to edit that cap instead of adding one. */
  budget: Budget | null;
  /** A category to start from when adding, with a suggested amount. */
  preset: UncappedCategory | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const { categories } = useCategories();
  const [categoryId, setCategoryId] = useState(preset ? String(preset.categoryId) : "");
  const [amount, setAmount] = useState(
    budget
      ? editableAmount(budget.amountMinor)
      : preset
        ? editableAmount(suggestedCap(preset))
        : "",
  );
  const [repeats, setRepeats] = useState(budget?.repeats ?? true);
  const [rollover, setRollover] = useState<Budget["rollover"]>(budget?.rollover ?? "off");
  const [fundOn, setFundOn] = useState(budget?.fund != null);
  const [fundTarget, setFundTarget] = useState(
    budget?.fund ? editableAmount(budget.fund.targetMinor) : "",
  );
  const [fundDate, setFundDate] = useState(budget?.fund?.targetDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = categoryOptions((categories ?? []).filter((c) => !existing.has(c.id)));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const minor = parseMoneyToMinor(amount, "USD");
    if (minor === null) {
      setError(
        "Enter the amount as a positive number with at most 2 decimal places, for example 400.",
      );
      return;
    }
    if (!budget && categoryId === "") {
      setError("Choose a category.");
      return;
    }
    const fundTargetMinor = fundOn ? parseMoneyToMinor(fundTarget, "USD") : null;
    if (fundOn && (fundTargetMinor === null || fundDate === "")) {
      setError("Enter how much the fund needs and by when.");
      return;
    }
    const options = {
      rollover,
      fundTargetMinor,
      fundTargetDate: fundOn ? fundDate : null,
      repeats,
    };
    setBusy(true);
    setError(null);
    try {
      if (budget) {
        await api(`/budgets/${budget.id}`, {
          method: "PATCH",
          // From a month that only inherits this cap, the change starts there.
          body: JSON.stringify({ amountMinor: minor, month, ...options }),
        });
        onSaved(`Updated the ${budget.categoryName} cap.`);
      } else {
        await api("/budgets", {
          method: "POST",
          body: JSON.stringify({
            categoryId: Number(categoryId),
            month,
            amountMinor: minor,
            ...options,
          }),
        });
        onSaved(
          repeats ? "Cap set, for this month and the ones after." : "Cap set for this month.",
        );
      }
    } catch (e) {
      setError(errorMessage(e, "Could not save the cap."));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        budget
          ? `Edit the ${budget.categoryName} cap`
          : `Set a spending cap from ${monthLabel(month, "long")}`
      }
      onClose={onCancel}
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        {!budget && (
          <div>
            <label htmlFor={`${id}-cat`} className="block font-medium">
              Category
            </label>
            <Select
              id={`${id}-cat`}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={inputClass}
            >
              <option value="">Choose a category</option>
              {options.map((o) => (
                <option key={o.id} value={o.id} data-depth={o.depth}>
                  {o.label}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-slate-500">
              Any category or subcategory. A cap on a category also counts its subcategories.
            </p>
          </div>
        )}
        <div>
          <label htmlFor={`${id}-amount`} className="block font-medium">
            Monthly cap (USD)
          </label>
          {preset && !budget && (
            <p className="mt-0.5 text-xs text-slate-500">
              {preset.averageMinor > 0
                ? `A typical month has been about ${formatMinor(preset.averageMinor, "USD")}.`
                : `${formatMinor(preset.spentMinor, "USD")} so far this month.`}
            </p>
          )}
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            value={amount}
            autoFocus
            onChange={(e) => setAmount(e.target.value)}
            placeholder="400.00"
            className={inputClass}
          />
        </div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={repeats}
            onChange={(e) => setRepeats(e.target.checked)}
          />
          <span>
            Keep this cap every month
            <span className="block text-xs text-slate-500">
              {repeats
                ? `Applies from ${monthLabel(month, "long")} on, until you stop or change it.`
                : `Applies to ${monthLabel(month, "long")} only.`}
            </span>
          </span>
        </label>
        <div>
          <label htmlFor={`${id}-roll`} className="block font-medium">
            At the end of the month
          </label>
          <Select
            id={`${id}-roll`}
            value={rollover}
            onChange={(e) => {
              const next = e.target.value as Budget["rollover"];
              setRollover(next);
              if (next === "off") setFundOn(false);
            }}
            className={inputClass}
          >
            <option value="off">Start fresh next month</option>
            <option value="leftover">Carry what is left into next month</option>
            <option value="all">Carry what is left, or take overspending off next month</option>
          </Select>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={fundOn}
            onChange={(e) => {
              setFundOn(e.target.checked);
              if (e.target.checked && rollover === "off") setRollover("leftover");
            }}
          />
          <span>
            Save up for an irregular expense{" "}
            <span className="text-xs text-slate-500">(insurance, gifts, car repairs)</span>
          </span>
        </label>
        {fundOn && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-fund`} className="block font-medium">
                Needed (USD)
              </label>
              <input
                id={`${id}-fund`}
                inputMode="decimal"
                value={fundTarget}
                onChange={(e) => setFundTarget(e.target.value)}
                placeholder="1200.00"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor={`${id}-fund-date`} className="block font-medium">
                By
              </label>
              <input
                id={`${id}-fund-date`}
                type="date"
                value={fundDate}
                onChange={(e) => setFundDate(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={primaryClass}>
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** What carried in, what carries on, and a fund's progress, in words. Pure. */
export function budgetNotes(b: Budget): string[] {
  const money = (n: number) => formatMinor(n, "USD");
  const notes: string[] = [];
  if (b.carryInMinor !== 0) {
    notes.push(
      b.carryInMinor > 0
        ? `${money(b.amountMinor)} + ${money(b.carryInMinor)} carried from last month`
        : `${money(b.amountMinor)} − ${money(-b.carryInMinor)} overspent last month`,
    );
  }
  if (b.rollover !== "off") {
    const carries = b.rollover === "leftover" ? Math.max(0, b.remainingMinor) : b.remainingMinor;
    notes.push(
      carries < 0
        ? `${money(-carries)} over comes off next month`
        : `${money(carries)} carries into next month`,
    );
  }
  if (b.fund) {
    notes.push(
      b.fund.reached
        ? `Fund: ${money(b.fund.targetMinor)} saved for ${formatDay(b.fund.targetDate)}`
        : `Fund: ${money(b.fund.targetMinor)} by ${formatDay(b.fund.targetDate)} · set aside ${money(b.fund.suggestedMinor)} a month (${b.fund.monthsLeft} month${b.fund.monthsLeft === 1 ? "" : "s"})`,
    );
  }
  return notes;
}

export function BudgetsPage() {
  const [month, setMonth] = useState(() => monthOf(today()));
  const day = today();
  const { data, error, loading, reload } = useApi<BudgetMonth>(
    `/budgets?month=${month}&today=${day}`,
  );
  const [form, setForm] = useState<Budget | UncappedCategory | "new" | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const money = (n: number) => formatMinor(n, "USD");
  const previous = shiftMonth(month, -1);
  const daysLeft = daysLeftIn(month, day);
  const caps = data ? sortCaps(data.budgets) : [];
  const attention = caps.filter((b) => b.status === "over" || b.status === "risk").length;
  // What one category spent this month, on the Transactions page.
  const transactionsLink = (categoryId: number): string =>
    `/transactions?${new URLSearchParams({
      category: String(categoryId),
      from: firstOfMonth(month),
      to: lastOfMonth(month),
    }).toString()}`;

  function changed(text: string): void {
    setNotice({ kind: "info", text });
    reload();
    announceDataChanged(); // dashboard budget widgets reload
  }

  async function copyFromPrevious(): Promise<void> {
    setBusy(true);
    try {
      const result = await api<{ created: number; skipped: number }>("/budgets/copy", {
        method: "POST",
        body: JSON.stringify({ fromMonth: previous, toMonth: month }),
      });
      changed(
        result.created === 0
          ? `Nothing to copy from ${monthLabel(previous, "long")}: it has no caps, or this month already has them.`
          : `Copied ${result.created} cap${result.created === 1 ? "" : "s"} from ${monthLabel(previous, "long")}.`,
      );
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not copy the caps.") });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/budgets/${deleting.id}?month=${month}`, { method: "DELETE" });
      changed(`Stopped the ${deleting.categoryName} cap.`);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not stop the cap.") });
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  return (
    <section className="@container max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Spending caps</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous month"
            className={buttonClass}
            onClick={() => setMonth(previous)}
          >
            ‹
          </button>
          <span className="min-w-32 text-center text-sm font-medium" aria-live="polite">
            {monthLabel(month, "long")}
          </span>
          <button
            type="button"
            aria-label="Next month"
            className={buttonClass}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-md px-3 py-2 text-sm ${notice.kind === "error" ? "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200" : "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200"}`}
        >
          {notice.text}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {loading && <Loading />}

      {data && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-64 flex-1 space-y-1">
              {data.budgets.length === 0 ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  No caps for this month yet. A cap sets the most to spend on a category, and shows
                  how the month is going against it.
                </p>
              ) : (
                <>
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    <span className="text-lg font-semibold text-slate-900 tabular-nums dark:text-slate-100">
                      {money(data.totals.spentMinor)}
                    </span>{" "}
                    of <span className="tabular-nums">{money(data.totals.budgetedMinor)}</span> in
                    caps,{" "}
                    <span
                      className={data.totals.remainingMinor < 0 ? "font-medium text-red-600" : ""}
                    >
                      {data.totals.remainingMinor < 0
                        ? `${money(-data.totals.remainingMinor)} over`
                        : `${money(data.totals.remainingMinor)} left`}
                    </span>
                    {daysLeft !== null && `, ${daysLeft} day${daysLeft === 1 ? "" : "s"} to go`}
                    {attention > 0 && `. ${attention} need${attention === 1 ? "s" : ""} a look.`}
                  </p>
                  <div className="max-w-xl">
                    <CapMeter
                      spentMinor={data.totals.spentMinor}
                      capMinor={data.totals.budgetedMinor}
                      expectedMinor={daysLeft === null ? null : totalExpected(caps)}
                      color={null}
                      label="All caps together"
                      description={`${money(data.totals.spentMinor)} of ${money(data.totals.budgetedMinor)} in caps.`}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => void copyFromPrevious()}
              >
                Copy from {monthLabel(previous)}
              </button>
              <button type="button" className={primaryClass} onClick={() => setForm("new")}>
                Set a cap
              </button>
            </div>
          </div>

          {/* Two columns of caps when the page has room. Those that need attention come first. */}
          <ul className="grid gap-3 @min-[56rem]:grid-cols-2">
            {caps.map((b) => (
              <li
                key={b.categoryId}
                className="space-y-1.5 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    to={transactionsLink(b.categoryId)}
                    title={`See ${b.categoryName} transactions for ${monthLabel(month, "long")}`}
                    className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                  >
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: b.categoryColor ?? "#94a3b8" }}
                    />
                    <span className="truncate">{b.categoryName}</span>
                  </Link>
                  <span className="tabular-nums">
                    <span className="font-medium">{money(b.spentMinor)}</span>
                    <span className="text-slate-500"> of {money(b.availableMinor)}</span>
                  </span>
                </div>
                <CapMeter
                  spentMinor={b.spentMinor}
                  capMinor={b.availableMinor}
                  expectedMinor={b.expectedMinor}
                  projectedMinor={b.projectedMinor}
                  color={b.categoryColor}
                  label={`${b.categoryName} cap`}
                  description={capReading(b, daysLeft, money)}
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <CapStatusLabel status={b.status} />
                      <span className="text-xs text-slate-600 dark:text-slate-300">
                        {capDetail(b, daysLeft, money)}
                      </span>
                    </div>
                    {budgetNotes(b).map((note) => (
                      <div key={note} className="text-xs text-slate-500">
                        {note}
                      </div>
                    ))}
                    {!b.repeats && (
                      <div className="text-xs text-slate-500">
                        For {monthLabel(month, "long")} only
                      </div>
                    )}
                    <div className="mt-1 flex gap-3 text-xs">
                      <button
                        type="button"
                        className="text-slate-600 underline hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
                        onClick={() => setForm(b)}
                        aria-label={`Edit the ${b.categoryName} cap`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-red-700 underline dark:text-red-400"
                        onClick={() => setDeleting(b)}
                        aria-label={`Stop the ${b.categoryName} cap`}
                      >
                        {b.repeats ? "Stop" : "Remove"}
                      </button>
                    </div>
                  </div>
                  {b.history && <CapHistoryChart history={b.history} />}
                </div>
              </li>
            ))}
          </ul>

          {(data.uncapped ?? []).length > 0 && (
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <h2 className="font-semibold">Spending with no cap</h2>
              {data.unbudgetedSpendingMinor > 0 && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {money(data.unbudgetedSpendingMinor)}{" "}
                  {daysLeft !== null ? "so far this month" : `in ${monthLabel(month, "long")}`} is
                  outside any cap.
                </p>
              )}
              <table className="mt-2 w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">Category</th>
                    <th className="py-1 text-right font-medium">{monthLabel(month)}</th>
                    <th className="py-1 text-right font-medium">Typical month</th>
                    <th className="py-1">
                      <span className="sr-only">Set a cap</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.uncapped!.map((c) => (
                    <tr
                      key={c.categoryId}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="py-1">
                        <span
                          aria-hidden="true"
                          className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: c.color ?? "#94a3b8" }}
                        />
                        {c.label}
                      </td>
                      <td className="py-1 text-right tabular-nums">{money(c.spentMinor)}</td>
                      <td className="py-1 text-right text-slate-500 tabular-nums">
                        {c.averageMinor > 0 ? money(c.averageMinor) : "No history"}
                      </td>
                      <td className="py-1 pl-3 text-right">
                        <button
                          type="button"
                          className="text-xs text-blue-600 underline dark:text-blue-400"
                          onClick={() => setForm(c)}
                          aria-label={`Set a cap for ${c.label}`}
                        >
                          Set a cap
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            On each bar, the small mark on top is an even pace for today and the paler part is where
            the month looks set to end. Spending follows the same rules as the dashboard: transfers
            and credit-card payments are left out, refunds reduce spending, and pending transactions
            are included.
          </p>
        </>
      )}

      {form && (
        <BudgetForm
          month={month}
          existing={new Set(data?.budgets.map((b) => b.categoryId))}
          budget={form !== "new" && "amountMinor" in form ? form : null}
          preset={form !== "new" && !("amountMinor" in form) ? form : null}
          onCancel={() => setForm(null)}
          onSaved={(text) => {
            setForm(null);
            changed(text);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`${deleting.repeats ? "Stop" : "Remove"} the ${deleting.categoryName} cap?`}
          message={
            deleting.repeats
              ? `Removes the ${money(deleting.amountMinor)} cap from ${monthLabel(month, "long")} on. Earlier months keep theirs, and your transactions are not affected.`
              : `Removes the ${money(deleting.amountMinor)} cap for ${monthLabel(month, "long")}. Your transactions are not affected.`
          }
          confirmLabel={deleting.repeats ? "Stop cap" : "Remove cap"}
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
