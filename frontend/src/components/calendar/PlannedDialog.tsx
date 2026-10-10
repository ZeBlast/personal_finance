import { useEffect, useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { categoryOptions } from "../../hooks/useCategories";
import { formatDay } from "../../lib/time";
import type { Account, Category } from "../../types/api";
import type { PlannedItem } from "../../types/calendar";
import { ConfirmDialog, Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";
import {
  buildPlannedPayload,
  buildRule,
  draftFromPlanned,
  emptyPlannedDraft,
  type PlannedDraft,
} from "./plannedForm";
import { weekdayOf } from "./range";

const DAYS = [
  { value: 0, short: "S", name: "Sunday" },
  { value: 1, short: "M", name: "Monday" },
  { value: 2, short: "T", name: "Tuesday" },
  { value: 3, short: "W", name: "Wednesday" },
  { value: 4, short: "T", name: "Thursday" },
  { value: 5, short: "F", name: "Friday" },
  { value: 6, short: "S", name: "Saturday" },
];

const UNITS: Record<string, string> = {
  daily: "day(s)",
  weekly: "week(s)",
  monthly: "month(s)",
  yearly: "year(s)",
};

/**
 * Adds a transaction the user expects, once or on a schedule (rent on the 1st, a paycheck every
 * other Friday, a gym fee on the 2nd Tuesday), or edits one. Nothing is charged: it only shows up
 * on the calendar and in the projected balance until the user records it or it appears from the bank.
 */
export function PlannedDialog({
  accounts,
  categories,
  defaultDate,
  defaultAccountId,
  planned,
  onSaved,
  onClose,
}: {
  accounts: Account[];
  categories: Category[];
  /** The day chosen on the calendar: the first occurrence. */
  defaultDate: string;
  defaultAccountId?: number | undefined;
  /** Set to edit this series instead of adding a new one. */
  planned?: PlannedItem | undefined;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const editing = planned !== undefined;
  const [draft, setDraft] = useState<PlannedDraft>(() =>
    planned
      ? draftFromPlanned(planned)
      : emptyPlannedDraft(defaultDate, defaultAccountId ? String(defaultAccountId) : ""),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const set = (change: Partial<PlannedDraft>): void => setDraft((d) => ({ ...d, ...change }));
  const options = categoryOptions(categories);
  const out = draft.direction === "out";
  const repeats = draft.frequency !== "once";

  // Show the next few dates the rule produces, so "every 2nd Tuesday" is never a guess.
  const rule = buildRule(draft);
  const ruleKey = rule.ok ? JSON.stringify(rule.rule) : null;
  useEffect(() => {
    if (ruleKey === null || !repeats) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<{ dates: string[] }>("/planned/preview", {
        method: "POST",
        body: JSON.stringify({ rule: JSON.parse(ruleKey) as unknown }),
      })
        .then((r) => !cancelled && setPreview(r.dates))
        .catch(() => !cancelled && setPreview(null));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ruleKey, repeats]);

  function toggleDay(day: number): void {
    set({
      weekdays: draft.weekdays.includes(day)
        ? draft.weekdays.filter((d) => d !== day)
        : [...draft.weekdays, day],
    });
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildPlannedPayload(draft);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(editing ? `/planned/${planned.id}` : "/planned", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(built.payload),
      });
      onSaved(editing ? "Expected transaction updated." : "Expected transaction added.");
    } catch (e) {
      setError(errorMessage(e, "Could not save the expected transaction."));
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!planned) return;
    setBusy(true);
    try {
      await api(`/planned/${planned.id}`, { method: "DELETE" });
      onSaved("Expected transaction deleted.");
    } catch (e) {
      setError(errorMessage(e, "Could not delete it."));
      setConfirmDelete(false);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? "Edit expected transaction" : "Add an expected transaction"}
      onClose={onClose}
      wide
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <fieldset>
          <legend className="font-medium">Which way will the money move?</legend>
          <div className="mt-1 flex gap-4">
            {(
              [
                ["out", "Money out (a payment or bill)"],
                ["in", "Money in (income or a deposit)"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-direction`}
                  value={value}
                  checked={draft.direction === value}
                  onChange={() => set({ direction: value })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-merchant`} className="block font-medium">
              {out ? "Paid to (merchant)" : "From (merchant or source)"}
            </label>
            <input
              id={`${id}-merchant`}
              value={draft.merchant}
              maxLength={200}
              autoFocus
              onChange={(e) => set({ merchant: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-amount`} className="block font-medium">
              Amount
            </label>
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              value={draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
              placeholder="12.50"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-account`} className="block font-medium">
              Account (optional)
            </label>
            <select
              id={`${id}-account`}
              value={draft.accountId}
              onChange={(e) => set({ accountId: e.target.value })}
              className={inputClass}
            >
              <option value="">Any account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-category`} className="block font-medium">
              Category (optional)
            </label>
            <select
              id={`${id}-category`}
              value={draft.categoryId}
              onChange={(e) => set({ categoryId: e.target.value })}
              className={inputClass}
            >
              <option value="">No category</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-person`} className="block font-medium">
              {out ? "Recipient (optional)" : "Sender (optional)"}
            </label>
            <input
              id={`${id}-person`}
              value={draft.person}
              maxLength={100}
              onChange={(e) => set({ person: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-700">
          <div>
            <label htmlFor={`${id}-start`} className="block font-medium">
              {repeats ? "Starts on" : "Date"}
            </label>
            <input
              id={`${id}-start`}
              type="date"
              value={draft.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-repeat`} className="block font-medium">
              Repeats
            </label>
            <select
              id={`${id}-repeat`}
              value={
                draft.frequency === "weekly" &&
                draft.repeatEvery === "2" &&
                draft.weekdays.length === 1
                  ? "biweekly"
                  : draft.frequency
              }
              onChange={(e) =>
                e.target.value === "biweekly"
                  ? set({
                      frequency: "weekly",
                      repeatEvery: "2",
                      weekdays: [weekdayOf(draft.startDate)],
                    })
                  : set({ frequency: e.target.value as PlannedDraft["frequency"] })
              }
              className={inputClass}
            >
              <option value="once">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks (biweekly)</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>

          {repeats && (
            <div className="flex items-end gap-2 sm:col-span-2">
              <label htmlFor={`${id}-every`} className="pb-1 font-medium">
                Every
              </label>
              <input
                id={`${id}-every`}
                type="number"
                min={1}
                max={365}
                value={draft.repeatEvery}
                onChange={(e) => set({ repeatEvery: e.target.value })}
                className={`${inputClass} !mt-0 w-20`}
              />
              <span className="pb-1">{UNITS[draft.frequency]}</span>
            </div>
          )}

          {draft.frequency === "weekly" && (
            <fieldset className="sm:col-span-2">
              <legend className="font-medium">On these days</legend>
              <div className="mt-1 flex gap-1">
                {DAYS.map((d) => {
                  const on = draft.weekdays.includes(d.value);
                  return (
                    <button
                      key={d.value}
                      type="button"
                      aria-pressed={on}
                      aria-label={d.name}
                      title={d.name}
                      onClick={() => toggleDay(d.value)}
                      className={`h-8 w-8 rounded-full border text-xs font-medium ${
                        on
                          ? "border-blue-600 bg-blue-600 text-white"
                          : "border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
                      }`}
                    >
                      {d.short}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {draft.frequency === "monthly" && (
            <div className="space-y-2 sm:col-span-2">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-monthmode`}
                    checked={draft.monthMode === "day"}
                    onChange={() => set({ monthMode: "day" })}
                  />
                  On a day of the month
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-monthmode`}
                    checked={draft.monthMode === "weekday"}
                    onChange={() => set({ monthMode: "weekday" })}
                  />
                  On a certain weekday
                </label>
              </div>
              {draft.monthMode === "day" ? (
                <div>
                  <label htmlFor={`${id}-dom`} className="block font-medium">
                    Day of the month
                  </label>
                  <select
                    id={`${id}-dom`}
                    value={draft.dayOfMonth}
                    onChange={(e) => set({ dayOfMonth: e.target.value })}
                    className={`${inputClass} max-w-48`}
                  >
                    <option value="">Same as the start date</option>
                    {Array.from({ length: 31 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {i + 1}
                      </option>
                    ))}
                    <option value="-1">Last day of the month</option>
                  </select>
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <div>
                    <label htmlFor={`${id}-nth`} className="block font-medium">
                      Which
                    </label>
                    <select
                      id={`${id}-nth`}
                      value={draft.nthWeek}
                      onChange={(e) => set({ nthWeek: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">As the start date falls</option>
                      <option value="1">1st</option>
                      <option value="2">2nd</option>
                      <option value="3">3rd</option>
                      <option value="4">4th</option>
                      <option value="-1">Last</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`${id}-wd`} className="block font-medium">
                      Weekday
                    </label>
                    <select
                      id={`${id}-wd`}
                      value={draft.monthWeekday}
                      onChange={(e) => set({ monthWeekday: e.target.value })}
                      className={inputClass}
                    >
                      <option value="">Same as the start date</option>
                      {DAYS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <p className="text-xs text-slate-500">
                A day that a month does not have (such as the 31st in April) uses its last day.
              </p>
            </div>
          )}

          {repeats && (
            <div className="space-y-1 sm:col-span-2">
              <div className="font-medium">Ends</div>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-end`}
                  checked={draft.endMode === "never"}
                  onChange={() => set({ endMode: "never" })}
                />
                Never
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-end`}
                  checked={draft.endMode === "on"}
                  onChange={() => set({ endMode: "on" })}
                />
                On
                <input
                  type="date"
                  aria-label="End date"
                  value={draft.endDate}
                  disabled={draft.endMode !== "on"}
                  onChange={(e) => set({ endDate: e.target.value })}
                  className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800"
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-end`}
                  checked={draft.endMode === "after"}
                  onChange={() => set({ endMode: "after" })}
                />
                After
                <input
                  type="number"
                  min={1}
                  aria-label="Number of times"
                  value={draft.maxCount}
                  disabled={draft.endMode !== "after"}
                  onChange={(e) => set({ maxCount: e.target.value })}
                  className="w-20 rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800"
                />
                times
              </label>
            </div>
          )}

          {repeats && preview && preview.length > 0 && (
            <p className="text-xs text-slate-500 sm:col-span-2" aria-live="polite">
              Next dates: {preview.map((d) => formatDay(d)).join(", ")}
            </p>
          )}
          {repeats && preview && preview.length === 0 && (
            <p className="text-xs text-amber-700 sm:col-span-2">
              This would not happen on any date from the start onward.
            </p>
          )}
        </div>

        <div>
          <label htmlFor={`${id}-notes`} className="block font-medium">
            Notes (optional)
          </label>
          <textarea
            id={`${id}-notes`}
            value={draft.notes}
            rows={2}
            maxLength={2000}
            onChange={(e) => set({ notes: e.target.value })}
            className={inputClass}
          />
        </div>

        <p className="text-xs text-slate-500">
          An expected transaction is a reminder: it appears on the calendar and in the projected
          balance. You can record it as a real transaction on a cash account when it happens, or
          skip it.
        </p>

        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <div>
            {editing && (
              <button
                type="button"
                className={`${buttonClass} text-red-700 dark:text-red-400`}
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={primaryClass} disabled={busy}>
              {busy ? "Saving..." : editing ? "Save" : "Add expected transaction"}
            </button>
          </div>
        </div>
      </form>
      {confirmDelete && planned && (
        <ConfirmDialog
          title="Delete this expected transaction?"
          message={`${planned.merchant} (${planned.repeats.toLowerCase()}) will be removed from the calendar, every date included.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  );
}
