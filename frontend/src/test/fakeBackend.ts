import { vi } from "vitest";

/** A recorded request to the fake backend. */
export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

type Answer = unknown | ((call: FakeCall) => unknown);

/**
 * Stands in for the app's backend in component tests: each "METHOD /path" (or just "/path" for
 * GET) answers with its value, or with what its function returns for the request. Anything else
 * is a 404, so a test notices a request it did not expect. Returns the requests made.
 */
export function fakeBackend(routes: Record<string, Answer>): FakeCall[] {
  const calls: FakeCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const path = url.replace(/^.*?\/api/, "");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      const call = { method, path, body };
      calls.push(call);
      const key = [`${method} ${path}`, method === "GET" ? path : null].find(
        (k) => k !== null && k in routes,
      );
      if (!key) {
        return new Response(
          JSON.stringify({ error: "not_found", message: `No fake for ${method} ${path}` }),
          {
            status: 404,
          },
        );
      }
      const answer = routes[key];
      const value =
        typeof answer === "function" ? (answer as (c: FakeCall) => unknown)(call) : answer;
      return value === undefined
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(value), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    }),
  );
  return calls;
}
