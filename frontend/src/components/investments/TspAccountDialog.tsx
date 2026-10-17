import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { buildAllocations, type AllocationRow, type TspFund } from "../../lib/tsp";
import { Modal } from "../common/Modal";
import { AllocationEditor } from "./AllocationEditor";
import { buttonClass, inputClass, primaryClass } from "./styles";
import { importTspActivity } from "./tspActivity";

/**
 * Creates a Thrift Savings Plan account kept by hand, with the split of future contributions between
 * funds, and (optionally) its past activity from the TSP's Investment Activity Detail file. What it
 * already holds can also be entered afterwards (Edit holdings), and a recurring contribution is set
 * up on the account itself.
 */
export function TspAccountDialog({
  onCreated,
  onCancel,
}: {
  /** With a note on the activity file, when one was imported (or could not be). */
  onCreated: (id: number, note?: string) => void;
  onCancel: () => void;
}) {
  const funds = useApi<TspFund[]>("/tsp/funds");
  const [name, setName] = useState("TSP");
  const [rows, setRows] = useState<AllocationRow[]>([{ symbol: "TSP-C", percent: "100" }]);
  const [activity, setActivity] = useState<File | null>(null);
  // A new account holds nothing yet, so the file's units are what it holds.
  const [updateHoldings, setUpdateHoldings] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Give the account a name.");
      return;
    }
    const built = buildAllocations(rows);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: number }>("/tsp/accounts", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), allocations: built.allocations }),
      });
      let note: string | undefined;
      if (activity) {
        // The account exists either way; a file that cannot be read is said so, not lost.
        try {
          note = `TSP account created. ${await importTspActivity(created.id, activity, updateHoldings)}`;
        } catch (e) {
          note = `TSP account created, but the activity file could not be imported: ${errorMessage(
            e,
            "it could not be read",
          )} Try again from the account's Import TSP activity button.`;
        }
      }
      onCreated(created.id, note);
    } catch (e) {
      setError(errorMessage(e, "Could not create the account."));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a Thrift Savings Plan account" onClose={onCancel} wide>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          For a TSP you keep by hand. Choose how new money is split between funds. You can then set
          up a recurring contribution, and the app turns each one into fund units at that day&apos;s
          price.
        </p>
        <div>
          <label htmlFor="tsp-name" className="block font-medium">
            Account name
          </label>
          <input
            id="tsp-name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <fieldset>
          <legend className="font-medium">Where new contributions go</legend>
          <div className="mt-1">
            <AllocationEditor
              funds={funds.data ?? []}
              rows={rows}
              onChange={setRows}
              idPrefix="new-tsp"
            />
          </div>
        </fieldset>
        <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <legend className="px-1 font-medium">Past activity (optional)</legend>
          <p className="text-slate-600 dark:text-slate-300">
            The Investment Activity Detail file from tsp.gov records every past contribution with
            its fund, units and price, as this account&apos;s activity.
          </p>
          <label className={`${buttonClass} inline-block cursor-pointer`}>
            {activity ? "Choose a different file" : "Choose activity file (CSV)"}
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => {
                setActivity(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>
          {activity && (
            <span className="ml-2 text-slate-600 dark:text-slate-300">
              {activity.name}{" "}
              <button
                type="button"
                className="text-xs text-slate-500 underline"
                onClick={() => setActivity(null)}
              >
                Remove
              </button>
            </span>
          )}
          {activity && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={updateHoldings}
                onChange={(e) => setUpdateHoldings(e.target.checked)}
                className="mt-1"
              />
              <span>
                Add the units in this file to what the account holds
                <span className="block text-xs text-slate-500">
                  Leave it on unless you will enter today&apos;s holdings yourself, or they would be
                  counted twice.
                </span>
              </span>
            </label>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={primaryClass} disabled={busy || funds.data === null}>
            {busy ? "Creating..." : "Create account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
