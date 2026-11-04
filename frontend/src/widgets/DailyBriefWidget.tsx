import { useState } from "react";
import { Link } from "react-router-dom";
import { Select } from "../components/common/Select";
import { useApi } from "../hooks/useApi";
import { api, errorMessage } from "../api/client";
import { formatMinor } from "../lib/money";
import { formatDay } from "../lib/time";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

export interface DailyBrief {
  currency: string;
  today: string;
  cashMinor: number;
  accountsCounted: number;
  nextIncome: {
    date: string;
    label: string;
    amountMinor: number;
    key: string;
    chosen: boolean;
  } | null;
  /** Income that can be picked to count up to. */
  incomeOptions: Array<{ key: string; date: string; label: string; amountMinor: number }>;
  /** The income picked is not expected in the next 60 days. */
  incomeChoiceMissing: boolean;
  until: string;
  obligations: Array<{ label: string; date: string; amountMinor: number; source: string }>;
  obligationsMinor: number;
  lowest: { date: string; balanceMinor: number };
  reservedMinor: number;
  reservedFor: Array<{ accountName: string; amountMinor: number }>;
  bufferMinor: number;
  safeToSpendMinor: number;
  shortMinor: number;
  perDayMinor: number | null;
  spentYesterdayMinor: number;
  spentThisMonthMinor: number;
  /** Bank accounts whose balance may be out of date. */
  staleAccounts?: Array<{ name: string; updatedAt: string | null; needsSignIn: boolean }>;
  /** Bank accounts left out because they have no balance yet. */
  missingAccounts: string[];
  /** Spending caps held back, and how much of that falls before the window ends. */
  capHoldBack: { included: boolean; inWindowMinor: number };
}

/** A warning when bank accounts are left out for having no balance, or null. Pure. */
export function missingWarning(b: DailyBrief): string | null {
  const names = b.missingAccounts;
  if (names.length === 0) return null;
  return `${names.join(", ")} ${names.length === 1 ? "has" : "have"} no balance yet, so ${names.length === 1 ? "it is" : "they are"} not counted.`;
}

/** One line saying whether spending caps are part of the number. Pure. */
export function holdBackNote(b: DailyBrief, money: (n: number) => string): string {
  if (!b.capHoldBack.included) {
    return "Spending caps are not held back. You can turn that on in Cash forecast.";
  }
  return `Includes ${money(b.capHoldBack.inWindowMinor)} held back for your spending caps.`;
}

/** A warning when the starting cash rests on old balances, or null when they are fresh. Pure. */
export function freshnessWarning(b: DailyBrief): string | null {
  const stale = b.staleAccounts ?? [];
  if (stale.length === 0) return null;
  const signIn = stale.filter((a) => a.needsSignIn).map((a) => a.name);
  if (signIn.length > 0) {
    return `${signIn.join(", ")} ${signIn.length === 1 ? "needs" : "need"} signing in again, so this uses an old balance.`;
  }
  return `${stale.map((a) => a.name).join(", ")} ${stale.length === 1 ? "has" : "have"} not synced in over a day: sync for an up-to-date figure.`;
}

export interface BriefStep {
  label: string;
  amountMinor: number;
  /** Smaller print under the line: what it is made of. */
  note?: string;
}

/** How safe-to-spend is worked out, line by line, so it can be checked. Pure. */
export function briefSteps(b: DailyBrief): BriefStep[] {
  const money = (n: number) => formatMinor(n, b.currency);
  const steps: BriefStep[] = [
    {
      label: "Cash in the bank now",
      amountMinor: b.cashMinor,
      note: `${b.accountsCounted} account${b.accountsCounted === 1 ? "" : "s"}`,
    },
  ];
  // Goal set-asides and the cap hold-back are not bills: each gets its own line.
  const charges = b.obligations.filter((o) => o.source !== "goal" && o.source !== "cap_holdback");
  const setAside = b.obligations.filter((o) => o.source === "goal");
  const held = b.obligations.filter((o) => o.source === "cap_holdback");
  const sum = (list: typeof charges) => list.reduce((n, o) => n + o.amountMinor, 0);
  const note = (list: typeof charges) =>
    list.map((o) => `${o.label} ${money(-o.amountMinor)}`).join(" · ");
  if (charges.length > 0) {
    steps.push({
      label: `Going out by ${formatDay(b.until)}`,
      amountMinor: sum(charges),
      note: note(charges),
    });
  }
  if (setAside.length > 0) {
    steps.push({ label: "Set aside for goals", amountMinor: sum(setAside), note: note(setAside) });
  }
  if (held.length > 0) {
    steps.push({ label: "Held back for spending caps", amountMinor: sum(held), note: note(held) });
  }
  // Everything above ends at the lowest balance: money arriving before the lowest day adds to
  // it, and what goes out after it does not count, so this step makes the lines add up.
  const toLowest = b.lowest.balanceMinor - (b.cashMinor + b.obligationsMinor);
  if (toLowest !== 0) {
    steps.push({
      label: `Adjusted to the lowest point, ${formatDay(b.lowest.date)}`,
      amountMinor: toLowest,
      note: `Cash is lowest on that day, at ${money(b.lowest.balanceMinor)}. Money arriving before it is added; what goes out after it does not count.`,
    });
  }
  if (b.reservedMinor > 0) {
    steps.push({
      label: "Held for goals",
      amountMinor: -b.reservedMinor,
      note: b.reservedFor.map((r) => `${r.accountName} ${money(r.amountMinor)}`).join(" · "),
    });
  }
  if (b.bufferMinor > 0) steps.push({ label: "Buffer you keep", amountMinor: -b.bufferMinor });
  return steps;
}

export default defineWidget({
  id: "daily-brief",
  title: "Safe to spend",
  description:
    "What you can spend until money next comes in, after bills, goals and a buffer, with how it is worked out.",
  group: "Spending",
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 4 },
  order: 5,
  singleton: true,
  defaultConfig: { buffer: 0 },
  configFields: [
    {
      key: "buffer",
      label: "Always keep at least (dollars)",
      type: "number",
      min: 0,
      max: 1_000_000,
      step: 50,
    },
  ],
  Component: function DailyBriefCard({ config }) {
    const bufferMinor = Math.round(Number(config.buffer) * 100);
    const { data, error, loading, reload } = useApi<DailyBrief>(
      `/brief?bufferMinor=${bufferMinor}`,
    );
    const [pickError, setPickError] = useState<string | null>(null);
    // The Select shows what the server says, so a failed save leaves it on the old choice.
    const pickIncome = async (key: string) => {
      setPickError(null);
      try {
        await api("/settings", {
          method: "PATCH",
          body: JSON.stringify({ briefIncomeKey: key === "" ? null : key }),
        });
        reload();
      } catch (err) {
        setPickError(errorMessage(err, "Could not save that choice."));
      }
    };
    const money = (n: number) => formatMinor(n, data?.currency ?? "USD");
    return (
      <WidgetState
        loading={loading}
        error={error}
        empty={data !== null && data.accountsCounted === 0}
        emptyText="Add a checking or savings account to see what is safe to spend."
      >
        {data && (
          <div className="space-y-2 text-sm">
            <div>
              <div
                className={`text-2xl font-semibold tabular-nums ${data.shortMinor > 0 ? "text-red-600 dark:text-red-400" : ""}`}
              >
                {money(data.safeToSpendMinor)}
              </div>
              <p className="text-xs text-slate-500">
                until {formatDay(data.until)}
                {data.nextIncome
                  ? `, before ${data.nextIncome.label} (${money(data.nextIncome.amountMinor)})`
                  : " (no income expected soon)"}
                {data.perDayMinor !== null && ` · about ${money(data.perDayMinor)} a day`}
              </p>
              {data.shortMinor > 0 && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {money(data.shortMinor)} short of your goals and buffer at the lowest point.
                </p>
              )}
            </div>
            {freshnessWarning(data) && (
              <p
                role="status"
                className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {freshnessWarning(data)}
              </p>
            )}
            {missingWarning(data) && (
              <p
                role="status"
                className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {missingWarning(data)}
              </p>
            )}
            {data.incomeOptions.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-slate-500">
                Counting to:
                <Select
                  value={data.nextIncome?.chosen ? data.nextIncome.key : ""}
                  onChange={(e) => void pickIncome(e.target.value)}
                  className="min-w-0 flex-1"
                >
                  <option value="">Next money in (automatic)</option>
                  {data.incomeOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}, {formatDay(o.date)} ({money(o.amountMinor)})
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {pickError && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {pickError}
              </p>
            )}
            {data.incomeChoiceMissing && (
              <p className="text-xs text-slate-500">
                The pay you chose is not expected in the next 60 days, so this counts to the next
                money in.{" "}
                <button
                  type="button"
                  className="text-blue-600 underline"
                  onClick={() => void pickIncome("")}
                >
                  Use the next income
                </button>
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-blue-600">
                How this is worked out
              </summary>
              <ul className="mt-1 space-y-1">
                {briefSteps(data).map((s) => (
                  <li key={s.label}>
                    <div className="flex justify-between gap-2">
                      <span>{s.label}</span>
                      <span className="tabular-nums">{money(s.amountMinor)}</span>
                    </div>
                    {s.note && <div className="text-xs text-slate-500">{s.note}</div>}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">
                Card purchases count once, when their bill is paid.
              </p>
            </details>
            <p className="text-xs text-slate-500">
              {holdBackNote(data, money)}{" "}
              <Link to="/planning" className="text-blue-600 underline">
                Cash forecast
              </Link>
            </p>
            <p className="text-xs text-slate-500">
              Spent yesterday {money(data.spentYesterdayMinor)} · this month{" "}
              {money(data.spentThisMonthMinor)}
            </p>
          </div>
        )}
      </WidgetState>
    );
  },
});
