// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { afterFailedCheck } from "../hooks/useBackendStatus";
import { fakeBackend } from "../test/fakeBackend";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A backend that refuses connections, as it does until it is listening, until `up` is called. */
function startingBackend(): { paths: string[]; up: () => void } {
  const paths: string[] = [];
  let listening = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/^.*?\/api/, "");
      paths.push(path);
      if (!listening) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ error: "not_found", message: "No fake" }), {
        status: path === "/health" ? 200 : 404,
      });
    }),
  );
  return {
    paths,
    up: () => {
      listening = true;
    },
  };
}

describe("opening the app before the backend is listening", () => {
  it("waits on a startup screen, asks for nothing else, then opens the app", async () => {
    const backend = startingBackend();
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    screen.getByText(/starting personal finance/i);
    await waitFor(() => expect(backend.paths).toContain("/health"));
    expect(backend.paths.every((p) => p === "/health")).toBe(true);
    expect(screen.queryByText(/could not load/i)).toBeNull();

    backend.up();
    await screen.findByRole("main", {}, { timeout: 3000 });
    expect(screen.queryByText(/starting personal finance/i)).toBeNull();
  });
});

describe("a failed check", () => {
  it("is still starting at first, then slow, and only later a problem", () => {
    expect(afterFailedCheck(1_000, false)).toEqual({ state: "starting", slow: false });
    expect(afterFailedCheck(9_000, false)).toEqual({ state: "starting", slow: true });
    expect(afterFailedCheck(61_000, false)).toMatchObject({ state: "down", wasReady: false });
  });

  it("is a problem straight away once the backend has answered", () => {
    expect(afterFailedCheck(1_000, true)).toMatchObject({ state: "down", wasReady: true });
  });
});

describe("the page area", () => {
  it("passes its full height down, for pages that fill the window like the calendar", async () => {
    fakeBackend({ "/health": { status: "ok" } });
    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <App />
      </MemoryRouter>,
    );
    const main = await screen.findByRole("main");
    expect(main.firstElementChild?.classList.contains("h-full")).toBe(true);
  });
});
