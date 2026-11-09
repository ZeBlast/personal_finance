// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import { PhoneViewerPanel, qrModules, type ViewerDevice } from "./PhoneViewerPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const device = (over: Partial<ViewerDevice> = {}): ViewerDevice => ({
  id: 1,
  deviceId: "11111111-2222",
  name: "Pixel",
  folder: "G:\\My Drive\\Viewer",
  file: "G:\\My Drive\\Viewer\\pf-viewer-pixel-111111.snap",
  pairedAt: "2026-11-09T10:00:00Z",
  lastWrittenAt: null,
  lastError: null,
  ...over,
});

describe("the pairing QR code", () => {
  it("is a square of modules with some dark ones", () => {
    const { size, dark } = qrModules('{"pfViewer":1,"key":"abc"}');
    expect(size).toBeGreaterThanOrEqual(21);
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.every(([x, y]) => x < size && y < size)).toBe(true);
  });
});

describe("phone viewer settings", () => {
  it("suggests the Google Drive folder, pairs, and shows the code once", async () => {
    const calls = fakeBackend({
      "/viewer/devices": { devices: [], suggestedFolder: "G:\\My Drive\\Personal Finance Viewer" },
      "POST /viewer/devices": {
        device: device(),
        pairing: {
          pfViewer: 1,
          deviceId: "11111111-2222",
          name: "Pixel",
          key: "k".repeat(43),
          file: "pf-viewer-pixel-111111.snap",
        },
      },
    });
    render(<PhoneViewerPanel />);
    const folder = await screen.findByLabelText(/Folder that syncs/);
    expect(folder).toHaveProperty("value", "G:\\My Drive\\Personal Finance Viewer");
    await userEvent.type(screen.getByLabelText("Phone name"), "Pixel");
    await userEvent.click(screen.getByRole("button", { name: "Pair and show the code" }));
    expect(await screen.findByRole("img", { name: "Pairing code for Pixel" })).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ name: "Pixel", folder: "G:\\My Drive\\Personal Finance Viewer" });
    await userEvent.click(screen.getByRole("button", { name: "Done, it is scanned" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull());
  });

  it("lists a phone with its last error, and writes on request", async () => {
    const calls = fakeBackend({
      "/viewer/devices": {
        devices: [device({ lastError: "Could not write to G:\\My Drive\\Viewer (ENOENT)." })],
        suggestedFolder: null,
      },
      "POST /viewer/write": { written: [1], failed: [] },
    });
    render(<PhoneViewerPanel />);
    expect(await screen.findByText(/Could not write to G:/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Write now" }));
    expect(await screen.findByText("Written for 1 phone(s).")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/viewer/write")).toBe(true);
  });
});
