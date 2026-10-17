import { useState } from "react";
import { errorMessage } from "../../api/client";
import { Modal } from "../common/Modal";
import { ActivitySection } from "./TspPanel";

/**
 * Importing the TSP's Investment Activity Detail file into a TSP account, from the account's own
 * Import button. Closes with the summary once the file is in.
 */
export function TspActivityDialog({
  accountId,
  accountName,
  holdsNothing,
  onDone,
  onCancel,
}: {
  accountId: number;
  accountName: string;
  /** The account holds nothing yet, so the file's units start as what it holds. */
  holdsNothing: boolean;
  onDone: (summary: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<string | void>, failure: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const summary = await work();
      onDone(summary || "Imported.");
    } catch (e) {
      setError(errorMessage(e, failure));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Import TSP activity into ${accountName}`} onClose={onCancel} wide>
      <ActivitySection
        accountId={accountId}
        busy={busy}
        run={run}
        defaultUpdateHoldings={holdsNothing}
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </Modal>
  );
}
