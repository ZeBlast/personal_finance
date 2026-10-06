/**
 * How the UI finds and authenticates to the local backend.
 *
 * - Inside the Tauri window, the Rust shell injects `window.__PF__` with the backend's port and
 *   this launch's token (the page itself comes from tauri.localhost, a different origin).
 * - In a browser tab the page is served by the backend itself, so requests are same-origin and
 *   the token travels in an HttpOnly cookie set when the tab was opened.
 */
export interface PfBootstrap {
  apiBase: string;
  token: string;
  /** Set by the shell if the backend could not be started. */
  bootError?: string;
}

declare global {
  interface Window {
    __PF__?: PfBootstrap;
  }
}

// Guarded so the module can also be loaded outside a browser (the automated tests do that).
export const bootstrap: PfBootstrap | undefined =
  typeof window === "undefined" ? undefined : window.__PF__;
export const insideTauri = bootstrap !== undefined;

/** A failed API call. `message` is safe to show to the user. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (bootstrap) headers.set("x-pf-token", bootstrap.token);
  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`${bootstrap?.apiBase ?? ""}/api${path}`, { ...init, headers });
  if (!response.ok) {
    let code = "request_failed";
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // The body was not JSON; keep the generic message.
    }
    throw new ApiError(response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The message to show for any thrown value. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** URL that opens this same UI in the system browser, carrying the token once. */
export function browserTabUrl(): string | undefined {
  return bootstrap
    ? `${bootstrap.apiBase}/?token=${encodeURIComponent(bootstrap.token)}`
    : undefined;
}
