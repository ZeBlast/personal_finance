import { describe, expect, it } from "vitest";
import { edgePoint, facingSide, routeLink } from "./flowGeometry";

const box = (x: number, y: number, w = 200, h = 100) => ({ x, y, w, h });

describe("cash-flow connection routing", () => {
  it("picks the side the line between centers actually crosses", () => {
    const a = box(0, 0);
    expect(facingSide(a, { x: 600, y: 50 })).toBe("right");
    expect(facingSide(a, { x: -400, y: 50 })).toBe("left");
    expect(facingSide(a, { x: 100, y: 400 })).toBe("bottom");
    expect(facingSide(a, { x: 100, y: -400 })).toBe("top");
  });

  it("slides the end along the edge toward the other bucket, not the middle of the side", () => {
    const a = box(0, 0); // center (100, 50)
    // Up and to the right, but mostly right: crosses the right edge above its middle.
    const p = edgePoint(a, { x: 500, y: -50 });
    expect(p.side).toBe("right");
    expect(p.point.x).toBe(200);
    expect(p.point.y).toBeCloseTo(50 - 100 * (100 / 400), 6); // 25
    // Straight across: the middle.
    expect(edgePoint(a, { x: 500, y: 50 }).point).toEqual({ x: 200, y: 50 });
  });

  it("keeps the end a little in from the corners", () => {
    // Far up and to the right: crosses the top edge, but stops short of the corner.
    const p = edgePoint(box(0, 0), { x: 1000, y: -480 });
    expect(p.side).toBe("top");
    expect(p.point.x).toBeLessThanOrEqual(200 - 14);
  });

  it("runs from the center of one bucket to the center of the other", () => {
    const link = routeLink(box(0, 0), box(400, 300));
    expect(link.start).toEqual({ x: 100, y: 50 });
    expect(link.end).toEqual({ x: 500, y: 350 });
    expect(link.d.startsWith("M 100 50 C")).toBe(true);
    expect(link.d.endsWith("500 350")).toBe(true);
    // The label sits between the two buckets' edges, not under either bucket.
    expect(link.mid.x).toBeGreaterThan(200);
    expect(link.mid.x).toBeLessThan(400);
  });
});

describe("snapping to the grid", () => {
  it("rounds to the nearest grid line", async () => {
    const { snap } = await import("./flowGeometry");
    expect(snap(35)).toBe(24);
    expect(snap(37)).toBe(48);
    expect(snap(-13)).toBe(-24);
  });

  it("resizes from the bottom-left corner on grid lines, never below the minimum", async () => {
    const { resizeFromBottomLeft } = await import("./flowGeometry");
    const start = { x: 240, y: 120, w: 216, h: 120 };
    const min = { w: 216, h: 120 };
    // Left 50 and down 30: the left edge snaps to 192, the bottom to 264.
    expect(resizeFromBottomLeft(start, -50, 30, min)).toEqual({ x: 192, w: 264, h: 144 });
    // Shrinking stops at the minimum, with the right and top edges where they were.
    expect(resizeFromBottomLeft(start, 300, -300, min)).toEqual({ x: 240, w: 216, h: 120 });
  });
});
