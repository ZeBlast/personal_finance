import { api, errorMessage } from "../../api/client";
import { announceDataChanged } from "../../lib/syncEvents";
import { toast } from "../../lib/toast";
import type { BatchUndoResult } from "../../types/api";
import { batchUndoText } from "./ruleText";

/** Puts a batch back and says what happened, in a toast; other views then reload. */
export async function undoBatch(id: number, then?: () => void): Promise<void> {
  try {
    const result = await api<BatchUndoResult>(`/rules/batches/${id}/undo`, { method: "POST" });
    toast(batchUndoText(result));
    announceDataChanged();
  } catch (e) {
    toast(errorMessage(e, "Could not undo that."), { kind: "error" });
  }
  then?.();
}

/** After a rule save that moved transactions: say how many, with a way to put them back. */
export function announceMoved(saved: { batchId: number | null; changeCount: number }): void {
  if (saved.batchId === null) return;
  announceDataChanged();
  const batchId = saved.batchId;
  toast(`Moved ${saved.changeCount} transaction${saved.changeCount === 1 ? "" : "s"}.`, {
    action: { label: "Undo", run: () => undoBatch(batchId) },
  });
}
