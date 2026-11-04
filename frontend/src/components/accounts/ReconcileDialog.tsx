import { useId, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { formatMinor, parseMoneyToMinor } from "../../lib/money";
import {
  causeLines,
  unconfirmedNote,
  type Reconciliation,
  type ReconciliationRecord,
  type SavedReconciliation,
} from "../../lib/reconcile";
import { announceDataChanged } from "../../lib/syncEvents";
import { formatDay } from "../../lib/time";
import { toast } from "../../lib/toast";
import type { Account } from "../../types/api";
import { ActionMenu } from "../common/ActionMenu";
import { askConfirm } from "../common/ConfirmHost";
import { Modal } from "../common/Modal";
import { inputClass, primaryClass } from "../common/styles";

export type { Reconciliation };

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

/** Compare the app's balance on a statement's closing day with the statement, and save the check. */
export function ReconcileDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const id = useId();
  const [date, setDate] = useState(today());
  const [balance, setBalance] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Why the check just saved was not marked as matched, until the day or balance changes.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const minor =
    balance.trim() === ""
      ? null
      : parseMoneyToMinor(balance, account.currency, { allowZero: true });
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const query = `date=${date}${minor !== null ? `&statementMinor=${minor}` : ""}`;
  const { data, error } = useApi<Reconciliation>(
    validDate ? `/accounts/${account.id}/reconcile?${query}` : null,
  );
  const records = useApi<ReconciliationRecord[]>(`/accounts/${account.id}/reconciliations`);
  const money = (n: number) => formatMinor(n, account.currency);
  const owed = account.type === "credit";
  const causes = data && data.differenceMinor ? causeLines(data, account.currency) : [];
  const unconfirmedPreview = data && data.differenceMinor === 0 ? unconfirmedNote(data.gaps) : null;
  const line = (l: Reconciliation["nearCutoff"][number]) => (
    <li key={l.id} className="flex justify-between gap-2">
      <span className="min-w-0 truncate">
        {formatDay(l.date)} · {l.merchant}
      </span>
      <span className="tabular-nums">{money(-l.amountMinor)}</span>
    </li>
  );

  async function save(): Promise<void> {
    if (minor === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api<SavedReconciliation>(`/accounts/${account.id}/reconciliations`, {
        method: "POST",
        body: JSON.stringify({
          statementDate: date,
          statementBalanceMinor: minor,
          note: note.trim() === "" ? null : note.trim(),
        }),
      });
      setUnconfirmed(saved.differenceMinor === 0 ? unconfirmedNote(saved.gaps) : null);
      setNote("");
      toast("Check saved.");
      records.reload();
      announceDataChanged();
    } catch (e) {
      setSaveError(errorMessage(e, "Could not save this check."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(r: ReconciliationRecord): Promise<void> {
    const ok = await askConfirm({
      title: "Delete this check?",
      message: `The check against the statement of ${formatDay(r.statementDate)} will be removed. Your transactions are not changed.`,
      confirmLabel: "Delete check",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/reconciliations/${r.id}`, { method: "DELETE" });
      records.reload();
      announceDataChanged();
    } catch (e) {
      toast(errorMessage(e, "Could not delete the check."), { kind: "error" });
    }
  }

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
              onChange={(e) => {
                setDate(e.target.value);
                setUnconfirmed(null);
              }}
              className={inputClass}
            />
          </label>
          <label htmlFor={`${id}-bal`} className="block font-medium">
            Ending {owed ? "balance owed" : "balance"}
            <input
              id={`${id}-bal`}
              inputMode="decimal"
              value={balance}
              placeholder="1234.56"
              onChange={(e) => {
                setBalance(e.target.value);
                setUnconfirmed(null);
              }}
              className={inputClass}
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
            {unconfirmedPreview && (
              <p className="text-amber-700 dark:text-amber-400">{unconfirmedPreview}</p>
            )}
            {causes.length > 0 && (
              <div>
                <h3 className="font-medium">What might explain it</h3>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {causes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
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
        {minor !== null && validDate && (
          <div className="space-y-2">
            <label htmlFor={`${id}-note`} className="block font-medium">
              Note (optional)
              <input
                id={`${id}-note`}
                value={note}
                maxLength={500}
                placeholder="What you found, or what to look at next"
                onChange={(e) => setNote(e.target.value)}
                className={inputClass}
              />
            </label>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className={primaryClass}
            >
              {saving ? "Saving..." : "Save this check"}
            </button>
            {saveError && (
              <p role="alert" className="text-red-600">
                {saveError}
              </p>
            )}
            {unconfirmed && (
              <p role="status" className="text-amber-700 dark:text-amber-400">
                {unconfirmed}
              </p>
            )}
          </div>
        )}
        {records.data && records.data.length > 0 && (
          <div>
            <h3 className="font-medium">Earlier checks</h3>
            <ul className="mt-1 divide-y divide-slate-200 dark:divide-slate-700">
              {records.data.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-2 py-1.5">
                  <div className="min-w-0">
                    <div>
                      {formatDay(r.statementDate)} · {money(r.statementBalanceMinor)} ·{" "}
                      <span
                        className={
                          r.status === "matched"
                            ? "text-green-700 dark:text-green-400"
                            : "text-amber-700 dark:text-amber-400"
                        }
                      >
                        {r.status === "matched"
                          ? "Matched"
                          : r.differenceMinor === 0
                            ? "Not confirmed"
                            : `Off by ${money(Math.abs(r.differenceMinor))}`}
                      </span>
                    </div>
                    {r.note && <p className="text-xs text-slate-500">{r.note}</p>}
                  </div>
                  <ActionMenu
                    label={`Actions for the check of ${formatDay(r.statementDate)}`}
                    items={[{ label: "Delete", danger: true, onSelect: () => void remove(r) }]}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
