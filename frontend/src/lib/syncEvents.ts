import { useEffect, useState } from "react";

/**
 * Lets any part of the UI announce "a sync just finished" so pages showing synced data (accounts,
 * transactions) can reload, whoever started the sync: the button, a connect, or the launch sync.
 */
const EVENT = "pf-sync-finished";

export function announceSyncFinished(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** Same signal, for changes made by hand (for example an edited credit limit) that other views show. */
export const announceDataChanged = announceSyncFinished;

/** A number that goes up each time a sync finishes; use it as an effect dependency to reload data. */
export function useSyncFinishedCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const onFinished = (): void => setCount((n) => n + 1);
    window.addEventListener(EVENT, onFinished);
    return () => window.removeEventListener(EVENT, onFinished);
  }, []);
  return count;
}
