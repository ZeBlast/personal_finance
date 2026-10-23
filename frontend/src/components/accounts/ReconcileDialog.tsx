import { useId, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Account } from "../../types/api";
import { Modal } from "../common/Modal";

export interface Reconciliation {
  accountId: number;
  accountName: string;
  type: "depository" | "credit";
  statementDate: string;
  currentMinor: number;
  sinceCount: number;
  sinceMinor: number;
  ledgerMinor: number;
  statementMinor: number | null;
  differenceMinor: number | null;
  nearCutoff: Array<{ id: number; date: string; merchant: string; amountMinor: number }>;
  pending: Array<{ id: number; date: string; merchant: string; amountMinor: number }>;
}

/** What a reconciliation found, in one sentence. Pure. */
export function reconcileVerdict(r: Reconciliation, currency = "USD"): string {
  if (r.differenceMinor === null) return "Enter the statement's ending balance to compare.";
  if (r.differenceMinor === 0) return "It matches: the app's records agree with the statement.";
  const by = formatMinor(Math.abs(r.differenceMinor), currency);
  // Higher on a bank statement means the app is missing money in (or has money out twice);
  // higher on a card statement means a charge is missing here (or a payment counted twice).
  const higher = r.differenceMinor > 0;
  const hint =
    r.type === "credit"
      ? higher
        ? "a charge may be missing here, or a payment counted twice"
        : "a charge may be counted twice here, or a payment is missing"
      : higher
        ? "a deposit may be missing here, or a purchase counted twice"
        : "a purchase may be missing here, or a deposit counted twice";
  return `The statement is ${by} ${higher ? "higher" : "lower"} than the app: ${hint}. Check the transactions near the closing day first.`;
}

const today = () => new Date().toISOString().slice(0, 10);

export function ReconcileButton({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  if (account.type !== "depository" && account.type !== "credit") return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
      >
        Reconcile
      </button>
      {open && <ReconcileDialog account={account} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Compare the app's balance on a statement's closing day with the statement. */
export function ReconcileDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const id = useId();
  const [date, setDate] = useState(today());
  const [balance, setBalance] = useState("");
  const minor =
    balance.trim() === ""
      ? null
      : parseMoneyToMinor(balance, account.currency, { allowZero: true });
  const query = `date=${date}${minor !== null ? `&statementMinor=${minor}` : ""}`;
  const { data, error } = useApi<Reconciliation>(
    /^\d{4}-\d{2}-\d{2}$/.test(date) ? `/accounts/${account.id}/reconcile?${query}` : null,
  );
  const money = (n: number) => formatMinor(n, account.currency);
  const owed = account.type === "credit";
  const line = (l: Reconciliation["nearCutoff"][number]) => (
    <li key={l.id} className="flex justify-between gap-2">
      <span className="min-w-0 truncate">
        {formatDay(l.date)} · {l.merchant}
      </span>
      <span className="tabular-nums">{money(-l.amountMinor)}</span>
    </li>
  );

  return (
    <Modal title={`Reconcile ${account.name}`} onClose={onClose} dismissible>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          From a statement: its closing day and ending {owed ? "balance owed" : "balance"}. The app
          works today&apos;s balance back through the transactions posted since, and shows any
          difference.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label htmlFor={`${id}-date`} className="block font-medium">
            Closing day
            <input
              id={`${id}-date`}
              type="date"
              value={date}
              max={today()}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
            />
          </label>
          <label htmlFor={`${id}-bal`} className="block font-medium">
            Ending {owed ? "balance owed" : "balance"}
            <input
              id={`${id}-bal`}
              inputMode="decimal"
              value={balance}
              placeholder="1234.56"
              onChange={(e) => setBalance(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {data && (
          <>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 rounded-md bg-slate-50 p-3 dark:bg-slate-800">
              <dt className="text-slate-500">{owed ? "Owed now" : "Balance now"}</dt>
              <dd className="text-right tabular-nums">{money(data.currentMinor)}</dd>
              <dt className="text-slate-500">
                Taking back {data.sinceCount} posted after {formatDay(data.statementDate)}
              </dt>
              <dd className="text-right tabular-nums">
                {money(owed ? -data.sinceMinor : data.sinceMinor)}
              </dd>
              <dt className="font-medium">App&apos;s figure on {formatDay(data.statementDate)}</dt>
              <dd className="text-right font-medium tabular-nums">{money(data.ledgerMinor)}</dd>
              {data.differenceMinor !== null && (
                <>
                  <dt className="font-medium">Difference</dt>
                  <dd
                    className={`text-right font-semibold tabular-nums ${data.differenceMinor === 0 ? "text-green-700 dark:text-green-400" : "text-red-600"}`}
                  >
                    {money(data.differenceMinor)}
                  </dd>
                </>
              )}
            </dl>
            <p
              role="status"
              className={
                data.differenceMinor === 0
                  ? "text-green-800 dark:text-green-300"
                  : "text-slate-700 dark:text-slate-200"
              }
            >
              {reconcileVerdict(data, account.currency)}
            </p>
            {data.nearCutoff.length > 0 && (
              <div>
                <h3 className="font-medium">Posted within 3 days of the closing day</h3>
                <p className="text-xs text-slate-500">
                  A bank may count one of these on the other side of the cutoff.
                </p>
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                  {data.nearCutoff.map(line)}
                </ul>
              </div>
            )}
            {data.pending.length > 0 && (
              <div>
                <h3 className="font-medium">Still pending ({data.pending.length})</h3>
                <p className="text-xs text-slate-500">Not in either figure until they post.</p>
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                  {data.pending.map(line)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
