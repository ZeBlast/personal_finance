import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { areas } from "../app/routes";

/**
 * The page the user came from, so a page opened from a report (Transactions filtered to a
 * category and month, say) can offer the way back to it.
 */

export interface PreviousPage {
  /** The full address, filters included. */
  to: string;
  /** The section's name, such as "Insights". */
  label: string;
}

let current: string | null = null;
let previous: string | null = null;
const listeners = new Set<() => void>();

/** The name of the section at a path ("/reports/spending" → "Spending"), or null. Pure. */
export function sectionLabel(path: string): string | null {
  for (const area of areas) {
    for (const s of area.sections) if (s.path === path) return s.label;
  }
  return null;
}

/** Records each address as the user moves; called once, in the app's layout. */
export function useTrackPages(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const here = `${pathname}${search}`;
    if (here === current) return;
    // A new page: the one before it becomes the previous. Filter changes on the same page do not.
    if (current !== null && current.split("?")[0] !== pathname) previous = current;
    current = here;
    for (const l of listeners) l();
  }, [pathname, search]);
}

/** The page before this one, when it was a different section. */
export function usePreviousPage(): PreviousPage | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (previous === null) return null;
  const label = sectionLabel(previous.split("?")[0]!);
  return label ? { to: previous, label } : null;
}
