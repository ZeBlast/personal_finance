import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./Modal";

/**
 * Closing an edit dialog (Escape, a click outside, Cancel, ✕) goes through `requestClose`: with no
 * changes it just closes; with changes it first asks whether to throw them away. Pressing Escape
 * again while asking goes back to editing. Render `confirm` inside the dialog.
 */
export function useUnsavedGuard(
  dirty: boolean,
  onClose: () => void,
): { requestClose: () => void; confirm: ReactNode } {
  const [asking, setAsking] = useState(false);
  const requestClose = useCallback(() => {
    if (asking) setAsking(false);
    else if (dirty) setAsking(true);
    else onClose();
  }, [asking, dirty, onClose]);
  const confirm = asking ? (
    <ConfirmDialog
      title="Discard changes?"
      message="You have changes that are not saved. Close without saving them?"
      confirmLabel="Discard changes"
      danger
      onConfirm={() => {
        setAsking(false);
        onClose();
      }}
      onCancel={() => setAsking(false)}
    />
  ) : null;
  return { requestClose, confirm };
}
