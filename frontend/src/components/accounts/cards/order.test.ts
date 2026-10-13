import { describe, expect, it } from "vitest";
import { applyOrder, moveBefore } from "./order";

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
