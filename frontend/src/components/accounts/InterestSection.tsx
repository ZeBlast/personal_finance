import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor } from "../../lib/money";
import { announceDataChanged } from "../../lib/syncEvents";
import type { Account } from "../../types/api";
import { buttonClass, inputClass, primaryClass } from "../investments/styles";

export interface AccountInterest {
  accountId: number;
  apyBps: number | null;
  balanceMinor: number | null;
  monthlyMinor: number | null;
  yearlyMinor: number | null;
  earnedThisYearMinor: number;
  earnedLast12MonthsMinor: number;
}

/** An APY typed as a percent ("4.25" or "4.25%") in hundredths of a percent, or null. Pure. */
export function parseApy(text: string): number | null {
  const t = text.trim().replace(/%$/, "");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps <= 5_000 ? bps : null;
}

export const formatApy = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/**
 * A bank account's interest: the APY the user enters, what that should pay at today's balance
 * (which the cash forecast counts at the end of each month), and the interest it has received.
 */
export function InterestSection({
  account,
  startOpen,
}: {
  account: Account;
  /** Show it expanded, for when the user came here to set the APY. */
  startOpen?: boolean;
}) {
  const { data, error, reload } = useApi<AccountInterest>(`/accounts/${account.id}/interest`);
  const [editing, setEditing] = useState(false);
  const money = (n: number) => formatMinor(n, account.currency);

  return (
    <details className="text-sm" open={startOpen}>
      <summary className="cursor-pointer text-xs text-slate-500">
        Interest
        {data?.apyBps != null ? ` · ${formatApy(data.apyBps)} APY` : " · set the APY"}
      </summary>
      <div className="mt-2 space-y-3">
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {data && data.apyBps !== null && data.monthlyMinor !== null && (
          <div>
            <div className="text-lg font-semibold tabular-nums">
              {money(data.monthlyMinor)}
              <span className="text-sm font-normal text-slate-500"> a month</span>
            </div>
            <div className="text-xs text-slate-500">
              About {money(data.yearlyMinor ?? 0)} over a year at {formatApy(data.apyBps)} APY on
              today&apos;s balance. The cash forecast counts it at the end of each month.
            </div>
          </div>
        )}
        {data && (
          <p className="text-xs text-slate-500">
            Received {money(data.earnedThisYearMinor)} in interest this year,{" "}
            {money(data.earnedLast12MonthsMinor)} in the last 12 months.
          </p>
        )}
        {editing ? (
          <ApyEditor
            account={account}
            current={data?.apyBps ?? null}
            onDone={(saved) => {
              setEditing(false);
              if (saved) {
                reload();
                announceDataChanged();
              }
            }}
          />
        ) : (
          <button type="button" className={buttonClass} onClick={() => setEditing(true)}>
            {data?.apyBps != null ? "Change APY" : "Set APY"}
          </button>
        )}
      </div>
    </details>
  );
}

function ApyEditor({
  account,
  current,
  onDone,
}: {
  account: Account;
  current: number | null;
  onDone: (saved: boolean) => void;
}) {
  const [text, setText] = useState(current === null ? "" : (current / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), [text]);
  const id = `apy-${account.id}`;

  async function send(method: "PUT" | "DELETE"): Promise<void> {
    const apyBps = parseApy(text);
    if (method === "PUT" && apyBps === null) {
      setError("Enter the APY as a percent from 0 to 50, such as 4.25.");
      return;
    }
    setBusy(true);
    try {
      await api(`/accounts/${account.id}/interest`, {
        method,
        ...(method === "PUT" ? { body: JSON.stringify({ apyBps }) } : {}),
      });
      onDone(true);
    } catch (e) {
      setError(errorMessage(e, "Could not save the APY."));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-28">
          <label className="block text-xs font-medium" htmlFor={id}>
            APY %
          </label>
          <input
            id={id}
            inputMode="decimal"
            value={text}
            placeholder="4.25"
            onChange={(e) => setText(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex-1" />
        {current !== null && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void send("DELETE")}
          >
            Remove
          </button>
        )}
        <button type="button" className={buttonClass} disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryClass}
          disabled={busy}
          onClick={() => void send("PUT")}
        >
          {busy ? "Saving..." : "Save APY"}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        The yearly rate your bank shows for this account, with compounding (APY).
      </p>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
