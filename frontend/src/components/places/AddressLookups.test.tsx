// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import type { GeocodeStatus } from "../../types/places";
import { AddressLookups } from "./AddressLookups";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const status = (over: Partial<GeocodeStatus>): GeocodeStatus => ({
  enabled: true,
  server: "https://nominatim.openstreetmap.org",
  running: false,
  total: 0,
  done: 0,
  found: 0,
  notFound: 0,
  pending: 0,
  stopped: null,
  message: null,
  ...over,
});

describe("address lookups", () => {
  it("starts a run for the addresses waiting", async () => {
    const calls = fakeBackend({
      "/geocode/status": status({ pending: 12 }),
      "POST /geocode/start": status({ pending: 12, running: true, total: 12 }),
    });
    render(<AddressLookups onFound={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Look up 12 addresses" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === "/geocode/start")).toBe(true),
    );
  });

  it("shows a progress bar, the time left and Stop while it runs", async () => {
    fakeBackend({
      "/geocode/status": status({
        running: true,
        total: 10,
        done: 4,
        found: 3,
        notFound: 1,
        pending: 6,
      }),
    });
    render(<AddressLookups onFound={() => {}} />);
    const bar = await screen.findByRole("progressbar", { name: "Address lookups" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByText(/Looked up 4 of 10 addresses/).textContent).toMatch(
      /About 12 seconds left/,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("offers no lookups until they are turned on", async () => {
    fakeBackend({ "/geocode/status": status({ enabled: false, pending: 5 }) });
    render(<AddressLookups onFound={() => {}} />);
    await screen.findByLabelText(/Look up street addresses/);
    expect(screen.queryByRole("button", { name: /Look up 5/ })).toBeNull();
  });
});
