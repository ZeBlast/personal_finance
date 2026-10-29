/**
 * Short pop-up confirmations ("Saved", "Synced: 8 new") in the corner, optionally with one action
 * such as Undo. Any code can call `toast(...)`; the <Toaster> in the app shell shows them.
 */
export type ToastKind = "success" | "info" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: { label: string; run: () => void | Promise<void> };
  /** Milliseconds before it goes away by itself. */
  duration: number;
}

type Listener = (toasts: readonly Toast[]) => void;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

/** At most this many show at once; the oldest makes room. */
const MAX_SHOWN = 4;

export function toast(
  text: string,
  options: { kind?: ToastKind; action?: Toast["action"]; duration?: number } = {},
): number {
  const id = nextId++;
  // An action (Undo) needs time to be read and clicked.
  const duration = options.duration ?? (options.action ? 7000 : 4000);
  toasts = [
    ...toasts,
    { id, kind: options.kind ?? "success", text, action: options.action, duration },
  ];
  if (toasts.length > MAX_SHOWN) {
    for (const old of toasts.slice(0, toasts.length - MAX_SHOWN)) clearTimer(old.id);
    toasts = toasts.slice(-MAX_SHOWN);
  }
  timers.set(id, setTimeout(() => dismissToast(id), duration));
  emit();
  return id;
}

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

export function dismissToast(id: number): void {
  clearTimer(id);
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: start from nothing. */
export function resetToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  toasts = [];
  emit();
}
