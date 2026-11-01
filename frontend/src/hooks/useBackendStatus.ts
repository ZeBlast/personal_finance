import { useEffect, useState } from "react";
import { api, bootstrap } from "../api/client";
import type { Health } from "../types/api";

export type BackendStatus =
  | { state: "starting"; slow: boolean }
  | { state: "ready"; health: Health }
  /** `wasReady` tells a backend that stopped from one that never started. */
  | { state: "down"; reason: string; wasReady: boolean };

/** When to say that starting is taking longer than usual. */
const SLOW_START_MS = 8_000;
/** How long to keep waiting before reporting a problem. After an update, preparing the data takes time. */
const START_GRACE_MS = 60_000;
const RETRY_FAST_MS = 600;
const RETRY_STEADY_MS = 5_000;

/** What a failed check means, `waited` milliseconds after the window opened. */
export function afterFailedCheck(waited: number, wasReady: boolean): BackendStatus {
  if (!wasReady && waited < START_GRACE_MS) {
    return { state: "starting", slow: waited >= SLOW_START_MS };
  }
  return { state: "down", reason: "The background service is not responding.", wasReady };
}

/**
 * Polls the backend. It takes a moment to start after the window opens, and it can stop later
 * (crash, port problem), so the UI keeps checking, shows a message instead of silently failing,
 * and recovers by itself if the backend comes back.
 */
export function useBackendStatus(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>(
    bootstrap?.bootError
      ? { state: "down", reason: bootstrap.bootError, wasReady: false }
      : { state: "starting", slow: false },
  );

  useEffect(() => {
    if (bootstrap?.bootError) return;
    let cancelled = false;
    let timer: number | undefined;
    let wasReady = false;
    const startedAt = Date.now();

    const check = async (): Promise<void> => {
      let next: BackendStatus;
      try {
        next = { state: "ready", health: await api<Health>("/health") };
        wasReady = true;
      } catch {
        next = afterFailedCheck(Date.now() - startedAt, wasReady);
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
