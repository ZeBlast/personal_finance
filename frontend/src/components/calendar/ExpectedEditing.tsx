import { useId, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import type { Account } from "../../types/api";
import type { CalendarEvent } from "../../types/calendar";
import { Select } from "../common/Select";

const input =
  "rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900";
const smallButton =
  "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";
const primary =
  "rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60";

/**
 * Changes one occurrence of a plan (another day, another amount) and says plainly what will and
 * will not change before it is saved: only this one moves; the series stays.
 */
export function ChangeOccurrenceForm({
  e,
  onDone,
  onNotice,
}: {
  e: CalendarEvent;
  onDone: () => void;
  onNotice: (n: { kind: "info" | "error"; text: string }) => void;
}) {
  const id = useId();
  const [day, setDay] = useState(e.date);
  const [amount, setAmount] = useState((e.amountMinor / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const minor = parseMoneyToMinor(amount, "USD");
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(day) && minor !== null && minor > 0;
  const sign = e.direction === "in" ? "+" : "−";

  async function save(): Promise<void> {
    if (!valid) return;
    setBusy(true);
    try {
      await api(`/planned/${e.plannedId}/occurrences/${e.originalDate}/change`, {
        method: "PUT",
        body: JSON.stringify({ moveTo: day, amountMinor: minor }),
      });
      onNotice({
        kind: "info",
        text: `${e.merchant} on ${formatDay(day)} is changed; the series is not.`,
      });
      announceDataChanged();
      onDone();
    } catch (err) {
      onNotice({ kind: "error", text: errorMessage(err, "Could not change this one.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-800">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5" htmlFor={`${id}-day`}>
          Day
          <input
            id={`${id}-day`}
            type="date"
            value={day}
            onChange={(ev) => setDay(ev.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-0.5" htmlFor={`${id}-amount`}>
          Amount
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            value={amount}
            onChange={(ev) => setAmount(ev.target.value)}
            className={`${input} w-28`}
          />
        </label>
      </div>
      {valid && (
        <p className="text-slate-600 dark:text-slate-300">
          Only this one changes: {formatDay(e.date)} {sign}
          {formatMinor(e.amountMinor, "USD")} becomes {formatDay(day)} {sign}
          {formatMinor(minor!, "USD")}. The rest of the series stays as it is.
        </p>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          className={primary}
          disabled={!valid || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving..." : "Change this one"}
        </button>
        <button type="button" className={smallButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A one-time expected item in a few fields, on the chosen day and account (both shown and
 * changeable). Repeating items use the full form.
 */
export function QuickAddExpected({
  day,
  accountId,
  accounts,
  onNotice,
}: {
  day: string;
  accountId: string;
  accounts: Account[];
  onNotice: (n: { kind: "info" | "error"; text: string }) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [date, setDate] = useState(day);
  const [account, setAccount] = useState(accountId);
  const [busy, setBusy] = useState(false);
  const minor = parseMoneyToMinor(amount, "USD");
  const valid = merchant.trim() !== "" && minor !== null && minor > 0 && date !== "";

  if (!open) {
    return (
      <button
        type="button"
        className={smallButton}
        onClick={() => {
          setDate(day);
          setAccount(accountId);
          setOpen(true);
        }}
      >
        + Quick add a one-time expected item
      </button>
    );
  }

  async function save(): Promise<void> {
    if (!valid) return;
    setBusy(true);
    try {
      await api("/planned", {
        method: "POST",
        body: JSON.stringify({
          merchant: merchant.trim(),
          amountMinor: minor,
          direction,
          accountId: account ? Number(account) : null,
          startDate: date,
          frequency: "once",
        }),
      });
      onNotice({ kind: "info", text: `${merchant.trim()} is expected on ${formatDay(date)}.` });
      setMerchant("");
      setAmount("");
      setOpen(false);
      announceDataChanged();
    } catch (err) {
      onNotice({ kind: "error", text: errorMessage(err, "Could not add it.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-2 rounded-md border border-slate-200 p-2 text-xs dark:border-slate-700"
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-32 flex-1 flex-col gap-0.5" htmlFor={`${id}-m`}>
          Who or what
          <input
            id={`${id}-m`}
            value={merchant}
            onChange={(ev) => setMerchant(ev.target.value)}
            className={input}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-0.5" htmlFor={`${id}-a`}>
          Amount
          <input
            id={`${id}-a`}
            inputMode="decimal"
            value={amount}
            onChange={(ev) => setAmount(ev.target.value)}
            className={`${input} w-24`}
          />
        </label>
        <div className="flex overflow-hidden rounded border border-slate-300 dark:border-slate-600">
          {(["out", "in"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              onClick={() => setDirection(d)}
              className={`px-2 py-1 ${direction === d ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900" : ""}`}
            >
              {d === "out" ? "Money out" : "Money in"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5" htmlFor={`${id}-d`}>
          Day
          <input
            id={`${id}-d`}
            type="date"
            value={date}
            onChange={(ev) => setDate(ev.target.value)}
            className={input}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          Account
          <Select
            aria-label="Account"
            value={account}
            onChange={(ev) => setAccount(ev.target.value)}
            className={input}
          >
            <option value="">Any account</option>
            {accounts.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <button type="submit" className={primary} disabled={!valid || busy}>
          {busy ? "Adding..." : "Add"}
        </button>
        <button type="button" className={smallButton} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
