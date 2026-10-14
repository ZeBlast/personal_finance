import { useEffect, useRef, type ReactNode } from "react";

/** The dialogs open now, oldest first: Escape closes only the one on top. */
const openDialogs: object[] = [];

/** Whether `dialog` is the one on top. Exported for tests. */
export function isTopDialog(dialog: object): boolean {
  return openDialogs[openDialogs.length - 1] === dialog;
}

/**
 * A simple centered dialog. Rendered in the page (not a native dialog) so it behaves the same
 * everywhere. Every dialog can be closed with its × button or Escape (wherever the focus is; with
 * dialogs on top of each other, only the top one closes). A click outside closes it too when it is
 * `dismissible`.
 */
export function Modal({
  title,
  onClose,
  wide,
  dismissible,
  children,
}: {
  title: string;
  onClose: () => void;
  /** A wider dialog, for forms; "full" nearly fills the screen, for tables. */
  wide?: boolean | "full";
  /**
   * Also closes on a click outside the window. For dialogs with nothing to lose (menus, lists) or
   * that ask before losing changes; other forms leave it off so a stray click keeps what was typed.
   */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  const self = useRef<object>({});

  useEffect(() => {
    const me = self.current;
    openDialogs.push(me);
    const onKey = (e: KeyboardEvent): void => {
      // A field that used Escape itself (an open list, a note being written) keeps it.
      if (e.key !== "Escape" || e.defaultPrevented || !isTopDialog(me)) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const at = openDialogs.indexOf(me);
      if (at >= 0) openDialogs.splice(at, 1);
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(e) => {
        // A press on the dark backdrop itself (not inside the window) closes it.
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      {/* Scrolls inside the window when the content is taller than the screen. */}
      <div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800 ${
          wide === "full" ? "max-w-[min(96vw,110rem)]" : wide ? "max-w-xl" : "max-w-md"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="-mt-1 -mr-2 rounded px-2 py-0.5 text-xl leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
          >
            ×
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="text-sm text-slate-600 dark:text-slate-300">{message}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-60 ${
            danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
          }`}
        >
          {busy ? "Working..." : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
