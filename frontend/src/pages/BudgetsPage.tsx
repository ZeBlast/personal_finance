import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api/client";
import { ProgressBar } from "../components/charts/ProgressBar";
import { ConfirmDialog, Modal } from "../components/common/Modal";
import { categoryOptions, useCategories } from "../hooks/useCategories";
import { useApi } from "../hooks/useApi";
import { announceDataChanged } from "../lib/syncEvents";
import { currencyDigits, formatMinor, parseMoneyToMinor } from "../lib/money";
import { monthLabel, monthOf, shiftMonth, today } from "../lib/period";
import { formatDay } from "../lib/time";
import type { Budget, BudgetMonth } from "../types/analytics";
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
  onSaved,
  onCancel,
}: {
  month: string;
  /** Categories that already have a budget this month (not offered again when adding). */
  existing: Set<number>;
  /** Set to edit that budget's amount instead of adding one. */
  budget: Budget | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const { categories } = useCategories();
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState(budget ? editableAmount(budget.amountMinor) : "");
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
    };
    setBusy(true);
    setError(null);
    try {
      if (budget) {
        await api(`/budgets/${budget.id}`, {
          method: "PATCH",
          body: JSON.stringify({ amountMinor: minor, ...options }),
        });
        onSaved(`Updated the ${budget.categoryName} budget.`);
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
        onSaved("Budget added.");
      }
    } catch (e) {
      setError(errorMessage(e, "Could not save the budget."));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        budget
          ? `Edit ${budget.categoryName} budget`
          : `Add a budget for ${monthLabel(month, "long")}`
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
              A budget for a category also counts spending in its subcategories.
            </p>
          </div>
        )}
        <div>
          <label htmlFor={`${id}-amount`} className="block font-medium">
            Monthly limit (USD)
          </label>
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
          <p className="mt-1 text-xs text-slate-500">
            Applies from this month on; copy the budgets to next month to keep it going.
          </p>
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
  const { data, error, loading, reload } = useApi<BudgetMonth>(`/budgets?month=${month}`);
  const [form, setForm] = useState<Budget | "new" | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const money = (n: number) => formatMinor(n, "USD");
  const previous = shiftMonth(month, -1);

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
          ? `Nothing to copy from ${monthLabel(previous, "long")}: it has no budgets, or this month already has them.`
          : `Copied ${result.created} budget${result.created === 1 ? "" : "s"} from ${monthLabel(previous, "long")}.`,
      );
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not copy the budgets.") });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/budgets/${deleting.id}`, { method: "DELETE" });
      changed(`Deleted the ${deleting.categoryName} budget.`);
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e, "Could not delete the budget.") });
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  return (
    <section className="@container max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Budgets</h1>
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {data.budgets.length === 0 ? (
                "No budgets for this month yet."
              ) : (
                <>
                  <span className="font-medium tabular-nums">{money(data.totals.spentMinor)}</span>{" "}
                  spent of <span className="tabular-nums">{money(data.totals.budgetedMinor)}</span>{" "}
                  budgeted ·{" "}
                  <span
                    className={data.totals.remainingMinor < 0 ? "font-medium text-red-600" : ""}
                  >
                    {data.totals.remainingMinor < 0
                      ? `${money(-data.totals.remainingMinor)} over`
                      : `${money(data.totals.remainingMinor)} left`}
                  </span>
                </>
              )}
            </p>
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
                Add budget
              </button>
            </div>
          </div>

          {/* Two columns of budgets when the page has room. */}
          <ul className="grid gap-3 @min-[56rem]:grid-cols-2">
            {data.budgets.map((b) => (
              <li
                key={b.id}
                className="space-y-1 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex items-center gap-2 font-medium">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: b.categoryColor ?? "#94a3b8" }}
                    />
                    {b.categoryName}
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={`tabular-nums ${b.overspent ? "font-medium text-red-600 dark:text-red-400" : ""}`}
                    >
                      {money(b.spentMinor)} / {money(b.availableMinor)}
                    </span>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => setForm(b)}
                      aria-label={`Edit the ${b.categoryName} budget`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={`${buttonClass} border-red-300 text-red-700 dark:border-red-800 dark:text-red-400`}
                      onClick={() => setDeleting(b)}
                      aria-label={`Delete the ${b.categoryName} budget`}
                    >
                      Delete
                    </button>
                  </span>
                </div>
                <ProgressBar
                  value={b.spentMinor}
                  max={Math.max(0, b.availableMinor)}
                  label={`${b.categoryName} budget`}
                  color={b.categoryColor}
                />
                <div
                  className={`text-xs ${b.overspent ? "text-red-600 dark:text-red-400" : "text-slate-500"}`}
                >
                  {b.overspent
                    ? `${money(-b.remainingMinor)} over budget`
                    : `${money(b.remainingMinor)} left`}{" "}
                  · {b.percentUsed}% used
                </div>
                {budgetNotes(b).map((note) => (
                  <div key={note} className="text-xs text-slate-500">
                    {note}
                  </div>
                ))}
              </li>
            ))}
            {data.budgets.length === 0 && (
              <li className="py-4 text-sm text-slate-500">
                Use “Add budget” to set a monthly limit for a category.
              </li>
            )}
          </ul>

          {data.unbudgetedSpendingMinor > 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {money(data.unbudgetedSpendingMinor)} was spent on things with no budget this month.
            </p>
          )}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Spending follows the same rules as the dashboard: transfers and credit-card payments are
            left out, refunds reduce spending, and pending transactions are included.
          </p>
        </>
      )}

      {form && (
        <BudgetForm
          month={month}
          existing={new Set(data?.budgets.map((b) => b.categoryId))}
          budget={form === "new" ? null : form}
          onCancel={() => setForm(null)}
          onSaved={(text) => {
            setForm(null);
            changed(text);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete the ${deleting.categoryName} budget?`}
          message={`Removes the ${money(deleting.amountMinor)} budget for ${monthLabel(month, "long")}. Your transactions are not affected.`}
          confirmLabel="Delete budget"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
