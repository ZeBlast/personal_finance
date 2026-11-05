import { useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { CADENCE_LABEL } from "../../lib/insights";
import { parseMoneyToMinor } from "../../lib/money";
import { describeAdjustment } from "../../lib/scenarios";
import type { Goal } from "../../pages/GoalsPage";
import type { PlannedItem } from "../../types/calendar";
import type {
  Scenario,
  ScenarioAdjustment,
  ScenarioCadence,
  SubscriptionReview,
} from "../../types/planning";
import { ActionMenu } from "../common/ActionMenu";
import { ConfirmDialog, Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { buttonClass, inputClass, primaryClass } from "../common/styles";

type Kind = ScenarioAdjustment["kind"];

const KIND_LABEL: Record<Kind, string> = {
  one_off: "A one-off amount",
  recurring: "A new regular amount",
  change_series: "Change or stop a regular payment",
  goal: "A different goal contribution",
};

interface Draft {
  id: number | null;
  name: string;
  adjustments: ScenarioAdjustment[];
  skipped: number;
}

/** The payments, planned items and goals a change can point at, and their names for describing changes. */
export function useScenarioPickers() {
  const subscriptions = useApi<SubscriptionReview>("/subscriptions").data?.subscriptions;
  const plannedItems = useApi<PlannedItem[]>("/planned").data;
  const goalList = useApi<Goal[]>("/goals").data;
  const subs = subscriptions ?? [];
  const planned = plannedItems ?? [];
  const goals = goalList ?? [];
  const names = {
    series: new Map(subs.map((s) => [s.key, s.merchant])),
    planned: new Map(planned.map((p) => [p.id, p.merchant])),
    goals: new Map(goals.map((g) => [g.id, g.name])),
  };
  return { subs, planned, goals, names };
}

/**
 * The saved what-ifs: make, rename, change and delete them. A scenario is only a list of changes
 * kept by name; the forecast tries them out on its own copy, so nothing here touches your real data.
 */
export function ScenarioDialog({
  scenarios,
  currency,
  today,
  days,
  unmatched,
  onChanged,
  onClose,
}: {
  scenarios: Scenario[];
  currency: string;
  today: string;
  /** The forecast window, for saying which changes match nothing in it. */
  days: number;
  /** For the scenario being compared: which of its changes matched nothing. */
  unmatched: { scenarioId: number; indexes: number[] } | null;
  /** After any save or delete; `savedId` is the scenario just saved. */
  onChanged: (savedId?: number) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { subs, planned, goals, names } = useScenarioPickers();

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({ name: draft.name.trim(), adjustments: draft.adjustments });
      const saved =
        draft.id === null
          ? await api<Scenario>("/forecast/scenarios", { method: "POST", body })
          : await api<Scenario>(`/forecast/scenarios/${draft.id}`, { method: "PUT", body });
      setDraft(null);
      onChanged(saved.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Scenario): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/forecast/scenarios/${s.id}`, { method: "DELETE" });
      setDeleting(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  if (draft) {
    const missed = unmatched && draft.id === unmatched.scenarioId ? unmatched.indexes : [];
    return (
      <Modal
        title={draft.id === null ? "New scenario" : "Edit scenario"}
        onClose={() => setDraft(null)}
        wide
        dismissible={false}
      >
        <div className="space-y-3 text-sm">
          <label className="block">
            Name
            <input
              className={inputClass}
              value={draft.name}
              maxLength={80}
              placeholder="For example: Rent goes up"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          {draft.skipped > 0 && (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
              {draft.skipped === 1
                ? "One saved change couldn't be read, so it isn't shown here. Saving drops it."
                : `${draft.skipped} saved changes couldn't be read, so they aren't shown here. Saving drops them.`}
            </p>
          )}
          <ul className="space-y-1">
            {draft.adjustments.map((a, i) => (
              <li
                key={i}
                className="flex items-start justify-between gap-2 rounded border border-slate-200 px-2 py-1 dark:border-slate-700"
              >
                <span>
                  {describeAdjustment(a, currency, names)}
                  {missed.includes(i) && (
                    <span className="block text-xs text-amber-700 dark:text-amber-400">
                      This change doesn&apos;t match anything in the next {days} days.
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() =>
                    setDraft({ ...draft, adjustments: draft.adjustments.filter((_, j) => j !== i) })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
            {draft.adjustments.length === 0 && (
              <li className="text-slate-500 dark:text-slate-400">No changes yet.</li>
            )}
          </ul>
          <AddChange
            currency={currency}
            today={today}
            subs={subs}
            planned={planned}
            goals={goals}
            disabled={draft.adjustments.length >= 50}
            onAdd={(a) => setDraft({ ...draft, adjustments: [...draft.adjustments, a] })}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            A scenario only changes the forecast you see here. It doesn&apos;t change your
            transactions, plans or goals, or how much is held back for spending caps.
          </p>
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={busy || draft.name.trim() === ""}
              onClick={() => void save()}
            >
              {busy ? "Saving..." : "Save scenario"}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Scenarios" onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          Try a change on the forecast without touching your real plans, like dropping a
          subscription or a bigger rent.
        </p>
        <ul className="space-y-1">
          {scenarios.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 dark:border-slate-700"
            >
              <span>
                <span className="font-medium">{s.name}</span>{" "}
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {s.adjustments.length} change{s.adjustments.length === 1 ? "" : "s"}
                </span>
                {s.skipped > 0 && (
                  <span className="block text-xs text-amber-700 dark:text-amber-400">
                    Some saved changes couldn&apos;t be read.
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() =>
                    setDraft({
                      id: s.id,
                      name: s.name,
                      adjustments: s.adjustments,
                      skipped: s.skipped,
                    })
                  }
                >
                  Edit
                </button>
                <ActionMenu
                  label={`More for ${s.name}`}
                  items={[{ label: "Delete", danger: true, onSelect: () => setDeleting(s) }]}
                />
              </span>
            </li>
          ))}
          {scenarios.length === 0 && (
            <li className="text-slate-500 dark:text-slate-400">No scenarios yet.</li>
          )}
        </ul>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-between gap-2">
          <button
            type="button"
            className={primaryClass}
            onClick={() => setDraft({ id: null, name: "", adjustments: [], skipped: 0 })}
          >
            New scenario
          </button>
          <button type="button" className={buttonClass} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete this scenario?"
          message={`“${deleting.name}” will be removed. Your real plans are not affected.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Modal>
  );
}

/** The small form that adds one change to the scenario being edited. */
function AddChange({
  currency,
  today,
  subs,
  planned,
  goals,
  disabled,
  onAdd,
}: {
  currency: string;
  today: string;
  subs: SubscriptionReview["subscriptions"];
  planned: PlannedItem[];
  goals: Goal[];
  disabled: boolean;
  onAdd: (a: ScenarioAdjustment) => void;
}) {
  const [kind, setKind] = useState<Kind>("one_off");
  const [label, setLabel] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [cadence, setCadence] = useState<ScenarioCadence>("monthly");
  const [target, setTarget] = useState("");
  const [goalId, setGoalId] = useState("");
  const [goalDay, setGoalDay] = useState("1");
  const [problem, setProblem] = useState<string | null>(null);

  function add(): void {
    setProblem(null);
    const minor = parseMoneyToMinor(amount, currency);
    const signed = minor === null ? null : direction === "out" ? -minor : minor;
    let built: ScenarioAdjustment;
    if (kind === "one_off" || kind === "recurring") {
      if (label.trim() === "") return setProblem("Give this change a name.");
      if (signed === null) return setProblem("Enter an amount above zero.");
      if (!date) return setProblem("Pick a day.");
      built =
        kind === "one_off"
          ? { kind, label: label.trim(), date, amountMinor: signed }
          : {
              kind,
              label: label.trim(),
              amountMinor: signed,
              cadence,
              startDate: date,
              endDate: endDate || null,
            };
      if (built.kind === "recurring" && built.endDate !== null && built.endDate < date)
        return setProblem("The end day is before the start.");
    } else if (kind === "change_series") {
      if (!target) return setProblem("Pick a payment.");
      if (!date) return setProblem("Pick a day.");
      if (amount.trim() !== "" && minor === null) return setProblem("Enter an amount above zero.");
      built = {
        kind,
        target: target.startsWith("p:")
          ? { plannedId: Number(target.slice(2)) }
          : { seriesKey: target.slice(2) },
        fromDate: date,
        amountMinor: minor,
      };
    } else {
      if (!goalId) return setProblem("Pick a goal.");
      const dayNumber = Number(goalDay);
      if (minor === null && amount.trim() !== "") return setProblem("Enter an amount above zero.");
      if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 28)
        return setProblem("Pick a day of the month from 1 to 28.");
      built = {
        kind,
        goalId: Number(goalId),
        forecast: minor === null ? null : { monthlyMinor: minor, day: dayNumber },
      };
    }
    onAdd(built);
    setLabel("");
    setAmount("");
    setEndDate("");
  }

  const stopping = (kind === "change_series" || kind === "goal") && amount.trim() === "";
  return (
    <fieldset className="space-y-2 rounded border border-dashed border-slate-300 p-3 dark:border-slate-600">
      <legend className="px-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        Add a change
      </legend>
      <label className="block">
        What kind of change
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          className={inputClass}
        >
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {(kind === "one_off" || kind === "recurring") && (
          <>
            <label className="block">
              Name
              <input
                className={inputClass}
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label className="block">
              Money
              <Select
                value={direction}
                onChange={(e) => setDirection(e.target.value as "out" | "in")}
                className={inputClass}
              >
                <option value="out">Going out</option>
                <option value="in">Coming in</option>
              </Select>
            </label>
          </>
        )}
        {kind === "change_series" && (
          <label className="block sm:col-span-2">
            Which payment
            <Select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={inputClass}
            >
              <option value="">Choose one</option>
              {subs
                .filter((s) => s.status === "active")
                .map((s) => (
                  <option key={s.key} value={`s:${s.key}`}>
                    {s.merchant}
                  </option>
                ))}
              {planned.map((p) => (
                <option key={p.id} value={`p:${p.id}`}>
                  {p.merchant} (expected)
                </option>
              ))}
            </Select>
          </label>
        )}
        {kind === "goal" && (
          <>
            <label className="block">
              Which goal
              <Select
                value={goalId}
                onChange={(e) => setGoalId(e.target.value)}
                className={inputClass}
              >
                <option value="">Choose one</option>
                {goals.map((g) => (
                  <option key={g.id} value={String(g.id)}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              Day of the month
              <input
                className={inputClass}
                inputMode="numeric"
                value={goalDay}
                onChange={(e) => setGoalDay(e.target.value)}
              />
            </label>
          </>
        )}
        <label className="block">
          {kind === "goal"
            ? "Set aside each month"
            : kind === "change_series"
              ? "New amount"
              : "Amount"}
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            placeholder={stopping ? "Leave blank to stop" : "0.00"}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        {kind !== "goal" && (
          <label className="block">
            {kind === "one_off" ? "On" : kind === "recurring" ? "Starting" : "From"}
            <input
              type="date"
              className={inputClass}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        )}
        {kind === "recurring" && (
          <>
            <label className="block">
              How often
              <Select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as ScenarioCadence)}
                className={inputClass}
              >
                {(Object.keys(CADENCE_LABEL) as ScenarioCadence[]).map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABEL[c]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              Until (optional)
              <input
                type="date"
                className={inputClass}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {problem && (
        <p role="alert" className="text-xs text-red-600">
          {problem}
        </p>
      )}
      <button type="button" className={buttonClass} disabled={disabled} onClick={add}>
        Add this change
      </button>
    </fieldset>
  );
}
