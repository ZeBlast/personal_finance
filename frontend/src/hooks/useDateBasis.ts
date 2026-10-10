import { useSyncExternalStore } from "react";

/**
 * Which date the calendar places transactions on: when they were made (`transaction`, the default)
 * or when they posted (`posted`). Remembered on this computer; every calendar view follows it.
 */
export type DateBasis = "transaction" | "posted";

const KEY = "pf.calendar.dateBasis";
const listeners = new Set<() => void>();

function read(): DateBasis {
  try {
    return localStorage.getItem(KEY) === "posted" ? "posted" : "transaction";
  } catch {
    return "transaction";
  }
}

let current: DateBasis = read();

export function setDateBasis(next: DateBasis): void {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not remembered, but still used for now.
  }
  listeners.forEach((l) => l());
}

export function useDateBasis(): DateBasis {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
