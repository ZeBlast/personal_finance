import { describe, expect, it } from "vitest";
import { applyOrder, moveBefore, moveBeside, moveToNewRow, normalizeRows } from "./order";

describe("banks laid out in rows", () => {
  it("keeps the saved rows in step with the banks there are", () => {
    expect(normalizeRows([], ["a", "b"])).toEqual([["a", "b"]]);
    expect(normalizeRows([["b"], ["gone", "a"]], ["a", "b", "c"])).toEqual([["b"], ["a", "c"]]);
    expect(normalizeRows([["a", "a"], ["gone"]], ["a"])).toEqual([["a"]]);
  });

  it("puts a bank beside another, before or after it, in that bank's row", () => {
    const rows = [["a", "b"], ["c"]];
    expect(moveBeside(rows, "c", "a", "before")).toEqual([["c", "a", "b"]]);
    expect(moveBeside(rows, "c", "a", "after")).toEqual([["a", "c", "b"]]);
    expect(moveBeside(rows, "a", "c", "after")).toEqual([["b"], ["c", "a"]]);
    expect(moveBeside(rows, "a", "a", "before")).toBe(rows);
  });

  it("moves a bank onto a line of its own, above, between or below the rows", () => {
    const rows = [["a", "b"], ["c"]];
    expect(moveToNewRow(rows, "b", 0)).toEqual([["b"], ["a"], ["c"]]);
    expect(moveToNewRow(rows, "b", 1)).toEqual([["a"], ["b"], ["c"]]);
    expect(moveToNewRow(rows, "a", 2)).toEqual([["b"], ["c"], ["a"]]);
    // Its own row emptied: that row goes away.
    expect(moveToNewRow(rows, "c", 1)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("the user's order of banks and cards", () => {
  it("puts things in the saved order, new ones after in their own order", () => {
    const items = ["a", "b", "c", "d"];
    expect(applyOrder(items, (x) => x, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
    expect(applyOrder(items, (x) => x, [])).toEqual(items);
    expect(applyOrder(items, (x) => x, ["gone", "d"])).toEqual(["d", "a", "b", "c"]);
  });

  it("moves a dragged one onto the place of the one it is dropped on", () => {
    expect(moveBefore(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveBefore(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveBefore(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(moveBefore(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });
});
