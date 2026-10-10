import { useEffect, type ReactNode } from "react";

/** A simple centered dialog. Rendered in the page (not a native dialog) so it behaves the same everywhere. */
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
   * Also closes on Escape wherever the focus is, and on a click outside the window. For dialogs
   * with nothing to lose (menus, lists); forms leave it off so a stray click keeps what was typed.
   */
  dismissible?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissible, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Handled once: a dismissible dialog also listens on the window.
          e.stopPropagation();
          onClose();
        }
      }}
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
        <h2 className="text-lg font-semibold">{title}</h2>
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
