import { useState } from "react";
import { api, errorMessage } from "../api/client";
import { CategorySelect } from "../components/common/CategorySelect";
import { Loading } from "../components/common/Loading";
import { Modal } from "../components/common/Modal";
import { useApi } from "../hooks/useApi";
import { formatMinor } from "../lib/money";
import { today } from "../lib/period";
import { fundChoices, fundPlan, itemLabel, shortMonths } from "../lib/planTools";
import { announceDataChanged } from "../lib/syncEvents";
import { formatDay } from "../lib/time";
import { toast } from "../lib/toast";
import type { Category } from "../types/api";
import type { YearAhead, YearItem } from "../types/planTools";

const monthShort = (month: string): string =>
  new Date(`${month}-15T12:00:00`).toLocaleString(undefined, { month: "short" });
const monthLong = (month: string): string =>
  new Date(`${month}-15T12:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" });

/** Sets up a spending cap that saves toward one coming cost, a little each month. */
function SaveForDialog({
  item,
  currency,
  onClose,
}: {
  item: YearItem;
  currency: string;
  onClose: () => void;
}) {
  const categories = useApi<Category[]>("/categories");
  const thisMonthCaps = useApi<{ budgets: Array<{ categoryId: number }> }>(
    `/budgets?month=${today().slice(0, 7)}&today=${today()}`,
  );
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thisMonth = today().slice(0, 7);
  const amount = -item.amountMinor;
  const plan = fundPlan(amount, item.date, thisMonth);
  const money = (n: number) => formatMinor(n, currency);
  // A category with a cap already is left out: a new one would quietly replace it.
  const choices = fundChoices(
    categories.data ?? [],
    new Set((thisMonthCaps.data?.budgets ?? []).map((b) => b.categoryId)),
  );

  async function save(): Promise<void> {
    if (!categoryId) {
      setError("Choose the category it is spent from.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/budgets", {
        method: "POST",
        body: JSON.stringify({
          categoryId: Number(categoryId),
          month: thisMonth,
          amountMinor: plan.perMonthMinor,
          rollover: "leftover",
          repeats: true,
          fundTargetMinor: amount,
          fundTargetDate: item.date,
        }),
      });
      announceDataChanged();
      toast(`Saving ${money(plan.perMonthMinor)} a month for ${item.label}.`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <Modal title={`Save for ${item.label}`} onClose={onClose}>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {money(amount)} by {formatDay(item.date)} is {money(plan.perMonthMinor)} a month for{" "}
        {plan.monthsLeft} {plan.monthsLeft === 1 ? "month" : "months"}. This adds a repeating
        spending cap that keeps what is left each month, so the fund builds up.
      </p>
      <label className="mt-3 block text-sm">
        Spent from
        <CategorySelect
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          aria-label="Category"
          className="mt-1 w-full"
        >
          <option value="">Choose a category</option>
          {choices.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </CategorySelect>
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Start saving
        </button>
      </div>
    </Modal>
  );
}

/** Planning > Year ahead: the next twelve months, and the costs that come once a year. */
export function YearAheadPage() {
  const { data, error, loading } = useApi<YearAhead>(`/year-ahead?today=${today()}`);
  const [saving, setSaving] = useState<YearItem | null>(null);
  const currency = data?.currency ?? "USD";
  const money = (n: number) => formatMinor(n, currency);
  const short = data ? shortMonths(data) : [];
  const items = data?.months.flatMap((m) => m.items) ?? [];
  const biggest = Math.max(
    1,
    ...(data?.months ?? []).map((m) =>
      Math.max(m.incomeMinor, m.billsMinor + m.capsMinor + m.usualMinor),
    ),
  );

  const summary = !data
    ? "The next twelve months, and the costs that do not come every month."
    : short.length === 0
      ? "Every month of the next twelve covers what is expected."
      : `${short.length} of the next twelve months ${short.length === 1 ? "is" : "are"} short: ${short.map(monthShort).join(", ")}.`;

  return (
    <section className="max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Year ahead</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{summary}</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {loading && !data && <Loading lines={6} />}
      {data && (
        <>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {data.months.map((m) => (
              <li
                key={m.month}
                aria-label={monthLong(m.month)}
                className={`rounded-lg border p-2 ${
                  m.short
                    ? "border-red-300 dark:border-red-800"
                    : "border-slate-200 dark:border-slate-700"
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium">{monthShort(m.month)}</span>
                  <span
                    className={`text-xs font-semibold tabular-nums ${
                      m.short
                        ? "text-red-600 dark:text-red-400"
                        : "text-slate-600 dark:text-slate-300"
                    }`}
                  >
                    {m.netMinor >= 0 ? "+" : "−"}
                    {money(Math.abs(m.netMinor))}
                  </span>
                </div>
                <div className="mt-2 space-y-1" aria-hidden="true">
                  <div
                    className="h-1.5 rounded bg-green-500"
                    style={{ width: `${(m.incomeMinor / biggest) * 100}%` }}
                  />
                  <div
                    className="h-1.5 rounded bg-slate-400 dark:bg-slate-500"
                    style={{
                      width: `${((m.billsMinor + m.capsMinor + m.usualMinor) / biggest) * 100}%`,
                    }}
                  />
                </div>
                {m.items.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                    {m.items.slice(0, 3).map((i, k) => (
                      <li key={`${i.label}-${k}`} className="truncate" title={i.label}>
                        {i.label}
                      </li>
                    ))}
                    {m.items.length > 3 && <li>and {m.items.length - 3} more</li>}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          <p className="flex gap-4 text-xs text-slate-500 dark:text-slate-400">
            <span>
              <span className="mr-1 inline-block h-1.5 w-3 rounded bg-green-500" />
              Coming in
            </span>
            <span>
              <span className="mr-1 inline-block h-1.5 w-3 rounded bg-slate-400" />
              Bills, caps and usual spending
            </span>
          </p>

          <div>
            <h2 className="text-lg font-semibold">Coming up</h2>
            {items.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Nothing out of the ordinary in the next twelve months.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-700">
                {items.map((i, k) => (
                  <li
                    key={`${i.date}-${i.label}-${k}`}
                    className="flex flex-wrap items-center gap-3 py-2 text-sm"
                  >
                    <span className="w-28 shrink-0 text-slate-500 dark:text-slate-400">
                      {formatDay(i.date)}
                    </span>
                    <span className="min-w-0 flex-1">
                      {i.label}
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {itemLabel(i.kind)}
                      </span>
                    </span>
                    {i.amountMinor !== 0 && (
                      <span className="tabular-nums">
                        {i.amountMinor > 0 ? "+" : "−"}
                        {money(Math.abs(i.amountMinor))}
                      </span>
                    )}
                    {i.amountMinor < 0 &&
                      i.date > data.today &&
                      (i.kind === "yearly" || i.kind === "quarterly" || i.kind === "planned") && (
                        <button
                          type="button"
                          onClick={() => setSaving(i)}
                          className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                        >
                          Save for this
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Built from your recurring payments, expected transactions, spending caps, goals and the
            debt payoff plan. Each month counts its whole spending caps.
          </p>
        </>
      )}
      {saving && (
        <SaveForDialog item={saving} currency={currency} onClose={() => setSaving(null)} />
      )}
    </section>
  );
}
