import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { buildAllocations, type AllocationRow, type TspFund } from "../../lib/tsp";
import { Modal } from "../common/Modal";
import { AllocationEditor } from "./AllocationEditor";
import { buttonClass, inputClass, primaryClass } from "./styles";

/**
 * Creates a Thrift Savings Plan account kept by hand, with the split of future contributions between
 * funds. What it already holds is entered afterwards (Edit holdings), and a recurring contribution
 * is set up on the account itself.
 */
export function TspAccountDialog({
  onCreated,
  onCancel,
}: {
  onCreated: (id: number) => void;
  onCancel: () => void;
}) {
  const funds = useApi<TspFund[]>("/tsp/funds");
  const [name, setName] = useState("TSP");
  const [rows, setRows] = useState<AllocationRow[]>([{ symbol: "TSP-C", percent: "100" }]);
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
      onCreated(created.id);
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
