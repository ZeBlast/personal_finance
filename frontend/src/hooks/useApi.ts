import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useSyncFinishedCount } from "../lib/syncEvents";

export interface ApiState<T> {
  data: T | null;
  /** A message safe to show, or null. */
  error: string | null;
  /** True while there is no data yet (the first load), not on later refreshes. */
  loading: boolean;
  /** True while it loads again with earlier data still on screen. */
  refreshing: boolean;
  reload: () => void;
}

/**
 * Loads `path` from the backend and keeps it fresh: it loads again when the path changes, after any
 * sync finishes, and on `reload()`. Pass `null` to wait (for example until a setting is known).
 * Earlier data stays on screen while a refresh is under way, so widgets do not flicker.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [fetching, setFetching] = useState(false);
  const synced = useSyncFinishedCount();

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setFetching(true);
    api<T>(path)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, "Could not load this."));
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, synced, version]);

  // A different path means different data, so do not show the old path's data while it loads.
  useEffect(() => {
    setData(null);
  }, [path]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return {
    data,
    error,
    loading: data === null && error === null && path !== null,
    refreshing: fetching && data !== null,
    reload,
  };
}
