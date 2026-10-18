import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../api/client";
import { ConfirmDialog, Modal } from "../components/common/Modal";
import { useUnsavedGuard } from "../components/common/useUnsavedGuard";
import { buttonClass, inputClass, primaryClass } from "../components/investments/styles";
import { useApi } from "../hooks/useApi";
import { formatMinor, parseMoneyToMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import type { Account } from "../types/api";

export interface Goal {
  id: number;
  name: string;
  targetMinor: number;
  targetDate: string | null;
  savedMinor: number;
  accountIds: number[];
  /** A set amount this goal owns in a linked account, by account ID; others share the rest. */
  accountAmounts: Record<string, number>;
  color: string | null;
  accounts: Array<{
    id: number;
    name: string;
    balanceMinor: number;
    /** What this goal owns of it. */
    countedMinor: number;
    setMinor: number | null;
    /** The set amount is more than the account had left for it. */
    short: boolean;
    sharedWith: string[];
  }>;
  currentMinor: number;
  percent: number;
  remainingMinor: number;
  monthsLeft: number | null;
  perMonthMinor: number | null;
  reached: boolean;
  overdue: boolean;
}

const money = (n: number) => formatMinor(n, "USD");

/** Savings goals: what each is for, how far along it is, and what a month gets it there. */
export function GoalsPage() {
  const goals = useApi<Goal[]>("/goals");
  const accounts = useApi<Account[]>("/accounts");
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function remove(): Promise<void> {
    if (!deleting) return;
    try {
      await api(`/goals/${deleting.id}`, { method: "DELETE" });
      setNotice(`${deleting.name} was deleted.`);
      goals.reload();
    } catch (e) {
      setNotice(errorMessage(e, "Could not delete the goal."));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Goals</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Save toward something: link the accounts the money sits in, or keep a running amount by
            hand, and see what a month gets you there on time.
          </p>
        </div>
        <button type="button" className={primaryClass} onClick={() => setEditing("new")}>
          Add a goal
        </button>
      </div>
      {notice && (
        <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800">
          {notice}
        </p>
      )}
      {goals.error && (
        <p role="alert" className="text-sm text-red-600">
          {goals.error}
        </p>
      )}
      {goals.data?.length === 0 && (
        <p className="text-sm text-slate-500">
          No goals yet. An emergency fund of three to six months of spending is a common first one.
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {goals.data?.map((g) => (
          <li
            key={g.id}
            className="space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">{g.name}</h2>
                <p className="text-xs text-slate-500">
                  {money(g.targetMinor)}
                  {g.targetDate ? ` by ${formatDay(g.targetDate)}` : ""}
                </p>
              </div>
              <div className="flex gap-1">
                <button type="button" className={buttonClass} onClick={() => setEditing(g)}>
                  Edit
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${g.name}`}
                  className={`${buttonClass} text-red-700 dark:text-red-400`}
                  onClick={() => setDeleting(g)}
                >
                  Delete
                </button>
              </div>
            </div>
            <div
              role="progressbar"
              aria-label={`${g.name} progress`}
              aria-valuenow={g.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
            >
              <div
                className={`h-full rounded-full ${g.reached ? "bg-green-600" : g.overdue ? "bg-amber-500" : "bg-blue-600"}`}
                style={{ width: `${g.percent}%` }}
              />
            </div>
            <div className="flex justify-between text-sm">
              <span className="font-medium tabular-nums">{money(g.currentMinor)}</span>
              <span className="text-slate-500">{g.percent}%</span>
            </div>
            <p className="text-sm">
              {g.reached ? (
                <span className="font-medium text-green-700 dark:text-green-400">Reached.</span>
              ) : g.overdue ? (
                <span className="text-amber-700 dark:text-amber-400">
                  The date has passed with {money(g.remainingMinor)} to go.
                </span>
              ) : g.perMonthMinor !== null ? (
                <>
                  <span className="font-medium">{money(g.perMonthMinor)} a month</span> for{" "}
                  {g.monthsLeft} month{g.monthsLeft === 1 ? "" : "s"} gets you there (
                  {money(g.remainingMinor)} to go).
                </>
              ) : (
                <>{money(g.remainingMinor)} to go.</>
              )}
            </p>
            {(g.accounts.length > 0 || g.savedMinor > 0) && (
              <ul className="space-y-0.5 text-xs text-slate-500">
                {g.accounts.map((a) => (
                  <li key={a.id}>{goalAccountText(a)}</li>
                ))}
                {g.savedMinor > 0 && <li>Kept elsewhere {money(g.savedMinor)}</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <GoalDialog
          goal={editing === "new" ? null : editing}
          accounts={(accounts.data ?? []).filter((a) => a.type !== "credit" && a.type !== "loan")}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setNotice(text);
            goals.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="The goal is removed. The accounts and their money are not touched."
          confirmLabel="Delete goal"
          danger
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

/** How much of an account a goal owns, and why: "Savings: $1,500 of $5,000 (set; shared with Car)". */
export function goalAccountText(a: Goal["accounts"][number]): string {
  const whole = a.countedMinor === a.balanceMinor && a.sharedWith.length === 0;
  const parts = [
    whole
      ? `${a.name}: ${money(a.balanceMinor)}`
      : `${a.name}: ${money(a.countedMinor)} of ${money(a.balanceMinor)}`,
  ];
  const notes: string[] = [];
  if (a.short && a.setMinor !== null) notes.push(`${money(a.setMinor)} set, not enough left`);
  else if (a.setMinor !== null) notes.push("set amount");
  if (a.sharedWith.length > 0) notes.push(`shared with ${a.sharedWith.join(", ")}`);
  return notes.length > 0 ? `${parts[0]} (${notes.join("; ")})` : parts[0]!;
}

function GoalDialog({
  goal,
  accounts,
  onClose,
  onSaved,
}: {
  goal: Goal | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const id = useId();
  const [initial] = useState(() => ({
    name: goal?.name ?? "",
    target: goal ? (goal.targetMinor / 100).toFixed(2) : "",
    date: goal?.targetDate ?? "",
    saved: goal && goal.savedMinor > 0 ? (goal.savedMinor / 100).toFixed(2) : "",
    accountIds: goal?.accountIds ?? [],
    // A set amount per linked account, as typed; empty shares the rest with other goals.
    amounts: Object.fromEntries(
      Object.entries(goal?.accountAmounts ?? {}).map(([k, v]) => [k, (v / 100).toFixed(2)]),
    ) as Record<string, string>,
  }));
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const { requestClose, confirm } = useUnsavedGuard(dirty && !busy, onClose);
  const set = (change: Partial<typeof form>) => setForm((f) => ({ ...f, ...change }));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const targetMinor = parseMoneyToMinor(form.target, "USD");
    if (!form.name.trim()) return setError("Give the goal a name.");
    if (targetMinor === null || targetMinor <= 0)
      return setError("Enter the target, such as 10000.");
    const savedMinor =
      form.saved.trim() === "" ? 0 : parseMoneyToMinor(form.saved, "USD", { allowZero: true });
    if (savedMinor === null) return setError("Enter the amount kept elsewhere, or leave it empty.");
    const accountAmounts: Record<string, number> = {};
    for (const accountId of form.accountIds) {
      const typed = (form.amounts[String(accountId)] ?? "").trim();
      if (typed === "") continue;
      const minor = parseMoneyToMinor(typed, "USD", { allowZero: true });
      if (minor === null) return setError("Enter each account's amount, or leave it empty.");
      accountAmounts[String(accountId)] = minor;
    }
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({
        name: form.name.trim(),
        targetMinor,
        targetDate: form.date || null,
        savedMinor,
        accountIds: form.accountIds,
        accountAmounts,
      });
      if (goal) await api(`/goals/${goal.id}`, { method: "PUT", body });
      else await api("/goals", { method: "POST", body });
      onSaved(goal ? `${form.name.trim()} was updated.` : `${form.name.trim()} was added.`);
    } catch (e) {
      setError(errorMessage(e, "Could not save the goal."));
      setBusy(false);
    }
  }

  return (
    <Modal title={goal ? "Edit goal" : "Add a goal"} onClose={requestClose} dismissible>
      {confirm}
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <div>
          <label htmlFor={`${id}-name`} className="block font-medium">
            What it is for
          </label>
          <input
            id={`${id}-name`}
            autoFocus
            maxLength={80}
            value={form.name}
            placeholder="Emergency fund"
            onChange={(e) => set({ name: e.target.value })}
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-target`} className="block font-medium">
              Target
            </label>
            <input
              id={`${id}-target`}
              inputMode="decimal"
              value={form.target}
              placeholder="10000.00"
              onChange={(e) => set({ target: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-date`} className="block font-medium">
              By (optional)
            </label>
            <input
              id={`${id}-date`}
              type="date"
              value={form.date}
              onChange={(e) => set({ date: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>
        <fieldset>
          <legend className="font-medium">Accounts the money is in</legend>
          <p className="text-xs text-slate-500">
            Set how much of an account is for this goal, or leave it empty to count what is left
            after other goals' set amounts (shared evenly with other goals that do the same).
          </p>
          <div className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {accounts.map((a) => {
              const linked = form.accountIds.includes(a.id);
              return (
                <div key={a.id} className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={linked}
                      onChange={(e) =>
                        set({
                          accountIds: e.target.checked
                            ? [...form.accountIds, a.id]
                            : form.accountIds.filter((x) => x !== a.id),
                        })
                      }
                    />
                    {a.name}
                    <span className="text-xs text-slate-500">
                      {formatMinor(a.currentBalanceMinor, a.currency)}
                    </span>
                  </label>
                  {linked && (
                    <input
                      aria-label={`Amount of ${a.name} for this goal`}
                      inputMode="decimal"
                      placeholder="The rest"
                      value={form.amounts[String(a.id)] ?? ""}
                      onChange={(e) =>
                        set({ amounts: { ...form.amounts, [String(a.id)]: e.target.value } })
                      }
                      className={`${inputClass} w-28`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
        <div>
          <label htmlFor={`${id}-saved`} className="block font-medium">
            Also saved elsewhere (optional)
          </label>
          <input
            id={`${id}-saved`}
            inputMode="decimal"
            value={form.saved}
            placeholder="0.00"
            onChange={(e) => set({ saved: e.target.value })}
            className={inputClass}
          />
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={requestClose}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? "Saving..." : goal ? "Save" : "Add goal"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
