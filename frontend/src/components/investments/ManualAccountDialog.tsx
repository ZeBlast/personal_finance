import { useId, useState, type FormEvent } from "react";
import { api, errorMessage } from "../../api/client";
import { Modal } from "../common/Modal";
import { buttonClass, inputClass, primaryClass } from "./styles";

/** Creates an investment account that is kept by hand, for institutions Plaid cannot connect. */
export function ManualAccountDialog({
  onCreated,
  onCancel,
}: {
  onCreated: (accountId: number) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [plan, setPlan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Give the account a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: number }>("/investments/accounts", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(plan.trim() ? { officialName: plan.trim() } : {}),
        }),
      });
      onCreated(created.id);
    } catch (e) {
      setError(errorMessage(e, "Could not create the account."));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add an investment account by hand" onClose={onCancel}>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        For accounts that cannot be connected automatically, such as the Thrift Savings Plan. You
        enter what it holds, or import a CSV file, and update it whenever you like.
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3 text-sm">
        <div>
          <label htmlFor={`${id}-name`} className="block font-medium">
            Account name
          </label>
          <input
            id={`${id}-name`}
            value={name}
            autoFocus
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="TSP"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${id}-plan`} className="block font-medium">
            Plan or institution (optional)
          </label>
          <input
            id={`${id}-plan`}
            value={plan}
            maxLength={120}
            onChange={(e) => setPlan(e.target.value)}
            placeholder="Thrift Savings Plan"
            className={inputClass}
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
          <button type="submit" disabled={busy} className={primaryClass}>
            {busy ? "Creating..." : "Create account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
