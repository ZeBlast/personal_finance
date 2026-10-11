import { describe, expect, it } from "vitest";
import { moveItem, orderRoutes } from "./Sidebar";

const routes = [{ path: "/" }, { path: "/a" }, { path: "/b" }, { path: "/c" }];

describe("sidebar order", () => {
  it("puts the user's order first and keeps pages it doesn't name", () => {
    expect(orderRoutes(routes, ["/c", "/a"]).map((r) => r.path)).toEqual(["/c", "/a", "/", "/b"]);
    expect(orderRoutes(routes, ["/gone", "/b"]).map((r) => r.path)).toEqual([
      "/b",
      "/",
      "/a",
      "/c",
    ]);
    expect(orderRoutes(routes, []).map((r) => r.path)).toEqual(["/", "/a", "/b", "/c"]);
  });

  it("moves a page down and up", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});
