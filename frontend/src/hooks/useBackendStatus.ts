import { useEffect, useState } from "react";
import { api, bootstrap } from "../api/client";
import type { Health } from "../types/api";

export type BackendStatus =
  { state: "starting" } | { state: "ready"; health: Health } | { state: "down"; reason: string };

/** How long to keep showing "starting" before reporting that the backend is not answering. */
const START_GRACE_MS = 10_000;
const RETRY_FAST_MS = 600;
const RETRY_STEADY_MS = 5_000;

/**
 * Polls the backend. It may take a moment to start after the window opens, and it can stop later
 * (crash, port problem), so the UI keeps checking, shows a banner instead of silently failing,
 * and recovers by itself if the backend comes back.
 */
export function useBackendStatus(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>(
    bootstrap?.bootError ? { state: "down", reason: bootstrap.bootError } : { state: "starting" },
  );

  useEffect(() => {
    if (bootstrap?.bootError) return;
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const check = async (): Promise<void> => {
      let next: BackendStatus;
      try {
        next = { state: "ready", health: await api<Health>("/health") };
      } catch {
        const waited = Date.now() - startedAt;
        next =
          waited < START_GRACE_MS
            ? { state: "starting" }
            : { state: "down", reason: "The background service is not responding." };
      }
      if (cancelled) return;
      setStatus(next);
      // Check quickly while starting up, then settle into a slower steady cadence.
      timer = window.setTimeout(check, next.state === "starting" ? RETRY_FAST_MS : RETRY_STEADY_MS);
    };

    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return status;
}
