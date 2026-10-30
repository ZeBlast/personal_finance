import { describe, expect, it } from "vitest";
import { activityKey, moveHighlight } from "./activityKeys";

describe("keyboard moves on Activity", () => {
  it("reads J/K, the arrows, X, Enter and Escape", () => {
    expect(
      ["j", "ArrowDown", "k", "ArrowUp", "x", "Enter", "Escape", "q"].map(activityKey),
    ).toEqual(["next", "next", "previous", "previous", "tick", "open", "clear", null]);
  });

  it("steps through the rows and stops at either end", () => {
    const ids = [10, 20, 30];
    expect(moveHighlight(ids, null, 1)).toBe(10);
    expect(moveHighlight(ids, null, -1)).toBe(30);
    expect(moveHighlight(ids, 10, 1)).toBe(20);
    expect(moveHighlight(ids, 30, 1)).toBe(30);
    expect(moveHighlight(ids, 10, -1)).toBe(10);
    // A highlight from another page starts again at the top.
    expect(moveHighlight(ids, 99, 1)).toBe(10);
    expect(moveHighlight([], null, 1)).toBeNull();
  });
});
