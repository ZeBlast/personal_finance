import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissToast, resetToasts, subscribeToasts, toast, type Toast } from "./toast";

describe("toasts", () => {
  afterEach(() => {
    resetToasts();
    vi.useRealTimers();
  });

  it("shows a toast, then removes it after its time (longer when it offers Undo)", () => {
    vi.useFakeTimers();
    let shown: readonly Toast[] = [];
    const stop = subscribeToasts((t) => (shown = t));
    toast("Saved");
    toast("Changed", { action: { label: "Undo", run: () => undefined } });
    expect(shown.map((t) => t.text)).toEqual(["Saved", "Changed"]);
    vi.advanceTimersByTime(4100);
    expect(shown.map((t) => t.text)).toEqual(["Changed"]);
    vi.advanceTimersByTime(3000);
    expect(shown).toEqual([]);
    stop();
  });

  it("keeps at most four, dropping the oldest, and can be dismissed", () => {
    let shown: readonly Toast[] = [];
    const stop = subscribeToasts((t) => (shown = t));
    const ids = ["a", "b", "c", "d", "e"].map((text) => toast(text));
    expect(shown.map((t) => t.text)).toEqual(["b", "c", "d", "e"]);
    dismissToast(ids[2]!);
    expect(shown.map((t) => t.text)).toEqual(["b", "d", "e"]);
    stop();
  });
});
