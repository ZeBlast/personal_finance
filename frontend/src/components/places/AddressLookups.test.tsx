// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import type { GeocodeStatus } from "../../types/places";
import { ConfirmHost } from "../common/ConfirmHost";
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
  unplaced: 0,
  lookups: 0,
  unchecked: 0,
  stopped: null,
  message: null,
  resetAvailableAt: null,
  ...over,
});

describe("address lookups", () => {
  it("starts a run for the addresses waiting", async () => {
    const calls = fakeBackend({
      "/geocode/status": status({ pending: 12, unplaced: 20 }),
      "POST /geocode/start": status({ pending: 12, running: true, total: 12 }),
    });
    render(<AddressLookups onFound={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start lookups" }));
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
    expect(screen.getByText(/Made 4 of 10 lookups/).textContent).toMatch(/About 12 seconds left/);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("offers no lookups until they are turned on", async () => {
    fakeBackend({ "/geocode/status": status({ enabled: false, pending: 5 }) });
    render(<AddressLookups onFound={() => {}} />);
    await screen.findByLabelText(/Look up street addresses/);
    expect(screen.queryByRole("button", { name: "Start lookups" })).toBeNull();
  });

  it("looks everything up again after asking, then starts", async () => {
    const calls = fakeBackend({
      "/geocode/status": status({ pending: 0, unplaced: 0 }),
      "POST /geocode/reset": status({ pending: 3, unplaced: 3 }),
      "POST /geocode/start": status({ running: true, total: 3, pending: 3 }),
    });
    render(
      <>
        <ConfirmHost />
        <AddressLookups onFound={() => {}} />
      </>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Look up all again" }));
    await userEvent.click(await screen.findByRole("button", { name: "Look everything up again" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
        "/geocode/reset",
        "/geocode/start",
      ]),
    );
  });

  it("says when looking everything up again is next possible", async () => {
    fakeBackend({
      "/geocode/status": status({ resetAvailableAt: "2026-11-15T10:00:00.000Z" }),
    });
    render(<AddressLookups onFound={() => {}} />);
    const button = await screen.findByRole("button", { name: "Look up all again" });
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText(/Available again on/)).toBeTruthy();
  });

  it("leads to the review once positions have been found", async () => {
    fakeBackend({ "/geocode/status": status({ lookups: 41, unchecked: 12 }) });
    const onReview = vi.fn();
    render(<AddressLookups onFound={() => {}} onReview={onReview} />);
    expect(await screen.findByText(/41 looked-up positions, 12 not checked yet\./)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalled();
  });

  it("offers no review before any lookup has found a position", async () => {
    fakeBackend({ "/geocode/status": status({ pending: 3 }) });
    render(<AddressLookups onFound={() => {}} onReview={() => {}} />);
    await screen.findByRole("button", { name: "Start lookups" });
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });
});
