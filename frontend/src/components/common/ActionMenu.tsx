import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MoreHorizontal } from "lucide-react";
import { buttonClass } from "./styles";

const itemClass =
  "block w-full px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:hover:bg-slate-700 dark:focus:bg-slate-700";

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  /** Shown in red: for something that deletes. */
  danger?: boolean;
}

/**
 * A "..." button that opens a small menu. It works from the keyboard too: Down opens it, the arrow
 * keys move through it, and Escape closes it. Clicking anywhere else closes it.
 */
export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // While open, the first item has focus and a click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => {
      if (!menuRef.current?.parentElement?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function menuKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const entries = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    entries[(at + step + entries.length) % entries.length]?.focus();
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${buttonClass} px-2`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={menuKey}
          className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-slate-300 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`${itemClass} ${item.danger ? "text-red-600 dark:text-red-400" : ""}`}
              onClick={() => {
                setOpen(false);
                // The menu is about to unmount the focused item: keep focus on the button.
                buttonRef.current?.focus();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
