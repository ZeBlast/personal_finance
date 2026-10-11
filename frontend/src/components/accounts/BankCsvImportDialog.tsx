import { useEffect, useId, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { Account } from "../../types/api";
import { Modal } from "../common/Modal";
import { buttonClass, primaryClass } from "../investments/styles";

interface ImportResult {
  format: string;
  rows: Array<{
    line: number;
    date: string;
    description: string;
    /** Positive when money comes into the account. */
    amountMinor: number;
    pending: boolean;
    duplicate: boolean;
  }>;
  added: number;
  duplicates: number;
  skipped: number;
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
}

/**
 * Imports a bank's CSV export (Wells Fargo, Chase, ...) into an account kept by hand: choose the
 * file, check the preview (what will be added, what is already there, the balance after), import.
 */
export function BankCsvImportDialog({
  account,
  onDone,
  onClose,
}: {
  account: Account;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [flip, setFlip] = useState(account.type === "credit");
  // An account that already holds money most likely includes this history in its balance.
  const [keepBalance, setKeepBalance] = useState((account.currentBalanceMinor ?? 0) !== 0);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = (dryRun: boolean) =>
    api<ImportResult>(`/accounts/manual/${account.id}/import-csv`, {
      method: "POST",
      body: JSON.stringify({ csv, flip, keepBalance, dryRun }),
    });

  useEffect(() => {
    if (csv === null) return;
    let cancelled = false;
    setError(null);
    send(true)
      .then((result) => !cancelled && setPreview(result))
      .catch((e: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setError(errorMessage(e, "The file could not be read."));
      });
    return () => {
      cancelled = true;
    };
  }, [csv, flip, keepBalance]);

  async function chooseFile(file: File | undefined): Promise<void> {
    if (!file) return;
    if (file.size > 4_000_000) {
      setError("That file is too large. Export a shorter date range.");
      return;
    }
    try {
      setFileName(file.name);
      setCsv(await file.text());
    } catch {
      setError("That file could not be read.");
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await send(false);
      onDone(
        `Imported ${result.added} transaction${result.added === 1 ? "" : "s"} into ${account.name}${
          result.duplicates ? ` (${result.duplicates} already there)` : ""
        }.`,
      );
    } catch (e) {
      setError(errorMessage(e, "Could not import the file."));
      setBusy(false);
    }
  }

  const fresh = preview ? preview.rows.filter((r) => !r.duplicate).length : 0;
  const money = (minor: number) => formatMinor(minor, account.currency ?? "USD");

  return (
    <Modal title={`Import a bank file into ${account.name}`} onClose={onClose} wide="full">
      <div className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          Choose a CSV file exported from your bank's website (Wells Fargo, Chase, Bank of America,
          and most others). Transactions already on this account are skipped, so importing the same
          file twice adds nothing.
        </p>
        <div>
          <label htmlFor={`${id}-file`} className="block font-medium">
            CSV file
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => void chooseFile(e.target.files?.[0])}
            className="mt-1 block w-full text-sm"
          />
          {fileName && <p className="mt-1 text-xs text-slate-500">Loaded {fileName}.</p>}
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
          The file shows money spent as positive amounts (common for credit card files)
        </label>
        <fieldset className="space-y-1">
          <legend className="font-medium">The balance</legend>
          <label className="flex items-center gap-2">
            <input type="radio" checked={keepBalance} onChange={() => setKeepBalance(true)} />
            Keep today's balance ({money(account.currentBalanceMinor ?? 0)}): these are past
            transactions it already includes
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!keepBalance} onChange={() => setKeepBalance(false)} />
            Add them to the balance: they are new since the balance was set
          </label>
        </fieldset>

        {preview && (
          <div>
            <p>
              <strong>{fresh}</strong> to add
              {preview.duplicates > 0 && `, ${preview.duplicates} already on the account`}
              {preview.skipped > 0 && `, ${preview.skipped} with no amount left out`}. Balance
              after: <strong>{money(preview.balanceAfterMinor)}</strong>.{" "}
              <span className="text-xs text-slate-500">Read as {preview.format}.</span>
            </p>
            <div className="mt-2 max-h-80 overflow-auto rounded border border-slate-200 dark:border-slate-700">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left dark:bg-slate-800">
                  <tr>
                    <th className="px-2 py-1 font-medium">Date</th>
                    <th className="px-2 py-1 font-medium">Description</th>
                    <th className="px-2 py-1 text-right font-medium">Amount</th>
                    <th className="px-2 py-1 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {preview.rows.map((r) => (
                    <tr key={r.line} className={r.duplicate ? "opacity-50" : ""}>
                      <td className="px-2 py-1 whitespace-nowrap">{formatDay(r.date)}</td>
                      <td className="px-2 py-1">{r.description}</td>
                      <td
                        className={`px-2 py-1 text-right whitespace-nowrap ${
                          r.amountMinor > 0 ? "text-green-700 dark:text-green-400" : ""
                        }`}
                      >
                        {money(r.amountMinor)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap text-slate-500">
                        {r.duplicate ? "Already there" : r.pending ? "Pending" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !preview || fresh === 0}
            className={primaryClass}
          >
            {busy ? "Importing..." : `Import ${fresh} transaction${fresh === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
