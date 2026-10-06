import { useId, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { formatMinor } from "../../lib/money";
import { Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "./styles";

type Kind = "holdings" | "transactions";

const HELP: Record<Kind, { title: string; columns: string; example: string; note: string }> = {
  holdings: {
    title: "Import holdings from a CSV file",
    columns:
      "symbol or name, quantity (or shares), price or value, and optionally cost_basis, asset_class, as_of (YYYY-MM-DD).",
    example: [
      "symbol,quantity,price,cost_basis,as_of",
      "G Fund,1200.5,17.75,20000.00,2026-09-30",
      "C Fund,310.25,98.1234,,2026-09-30",
      "L 2050,12,30.00,,",
    ].join("\n"),
    note: "The file replaces what the account holds, so importing the same file again changes nothing. TSP funds are recognized by names such as “G Fund”, “TSP-C” or “L 2050”.",
  },
  transactions: {
    title: "Import transactions from a CSV file",
    columns:
      "date (YYYY-MM-DD), type (buy, sell, dividend, interest, contribution, withdrawal, fee, transfer, other), amount, and optionally symbol, name, quantity, price, fees, description.",
    example: [
      "date,type,symbol,quantity,price,amount",
      "2026-09-01,contribution,,,,500.00",
      "2026-09-02,buy,C Fund,10,98.00,",
      "2026-09-20,dividend,G Fund,,,12.34",
    ].join("\n"),
    note: "Enter amounts as positive numbers; the type decides which way the cash moves. Rows already imported are skipped, so importing the same file again adds nothing.",
  },
};

/** Imports a CSV file (chosen or pasted) into a manual account. Nothing is imported if any row is bad. */
export function CsvImportDialog({
  kind,
  accountId,
  accountName,
  onDone,
  onCancel,
}: {
  kind: Kind;
  accountId: number;
  accountName: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const help = HELP[kind];
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function chooseFile(file: File | undefined): Promise<void> {
    if (!file) return;
    if (file.size > 800_000) {
      setError("That file is too large. Split it into smaller files (under about 5,000 rows).");
      return;
    }
    try {
      setText(await file.text());
      setFileName(file.name);
      setError(null);
    } catch {
      setError("That file could not be read.");
    }
  }

  async function submit(): Promise<void> {
    if (text.trim() === "") {
      setError("Choose a file, or paste its contents below.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        count?: number;
        totalMinor?: number;
        added?: number;
        skipped?: number;
      }>(`/investments/accounts/${accountId}/import/${kind}`, {
        method: "POST",
        body: JSON.stringify({ csv: text }),
      });
      onDone(
        kind === "holdings"
          ? `Imported ${result.count ?? 0} holding${result.count === 1 ? "" : "s"} into ${accountName}, worth ${formatMinor(result.totalMinor ?? 0, "USD")}.`
          : `Imported ${result.added ?? 0} new transaction${result.added === 1 ? "" : "s"} into ${accountName}${
              result.skipped ? ` (${result.skipped} already there)` : ""
            }.`,
      );
    } catch (e) {
      setError(errorMessage(e, "Could not import the file."));
      setBusy(false);
    }
  }

  return (
    <Modal title={help.title} onClose={onCancel} wide>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          Columns, with a header row first: {help.columns}
        </p>
        <details>
          <summary className="cursor-pointer text-blue-700 dark:text-blue-400">
            Show an example
          </summary>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-900">
            {help.example}
          </pre>
          <p className="mt-2 text-xs text-slate-500">{help.note}</p>
        </details>
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
        <div>
          <label htmlFor={`${id}-text`} className="block font-medium">
            Or paste the contents
          </label>
          <textarea
            id={`${id}-text`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
            }}
            rows={6}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs`}
          />
        </div>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={buttonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={primaryClass}
          >
            {busy ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
