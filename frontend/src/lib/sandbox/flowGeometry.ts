/**
 * Where a cash-flow connection meets its buckets. Each end sits where the straight line between the
 * two buckets' centers crosses that bucket's edge, so the point slides along the edge (and around
 * corners) as the buckets move relative to each other. The curve leaves each edge straight out of
 * it, so lines stay smooth.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export type Side = "left" | "right" | "top" | "bottom";

export const centerOf = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The side of `box` that faces the point `toward`. */
export function facingSide(box: Box, toward: Point): Side {
  const c = centerOf(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  // Compare against the box's shape: the side the line from the center actually crosses.
  if (Math.abs(dx) * box.h >= Math.abs(dy) * box.w) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

const OUT: Record<Side, Point> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

/**
 * Where the line from the center of `box` toward `toward` leaves the box, kept a little in from the
 * corners, and the direction pointing out of the box there.
 */
export function edgePoint(box: Box, toward: Point): { point: Point; out: Point; side: Side } {
  const c = centerOf(box);
  const side = facingSide(box, toward);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const inset = Math.min(14, box.w / 4, box.h / 4);
  let point: Point;
  if (side === "left" || side === "right") {
    const x = side === "right" ? box.x + box.w : box.x;
    const t = dx === 0 ? 0 : (x - c.x) / dx;
    const y = c.y + dy * t;
    point = { x, y: clamp(y, box.y + inset, box.y + box.h - inset) };
  } else {
    const y = side === "bottom" ? box.y + box.h : box.y;
    const t = dy === 0 ? 0 : (y - c.y) / dy;
    const x = c.x + dx * t;
    point = { x: clamp(x, box.x + inset, box.x + box.w - inset), y };
  }
  return { point, out: OUT[side], side };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * A smooth curve between two points that bends along whichever way they are further apart:
 * side by side it eases out horizontally, one above the other it eases out vertically.
 */
function curveBetween(from: Point, to: Point): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const [c1, c2] =
    Math.abs(dx) >= Math.abs(dy)
      ? [
          { x: from.x + dx / 2, y: from.y },
          { x: to.x - dx / 2, y: to.y },
        ]
      : [
          { x: from.x, y: from.y + dy / 2 },
          { x: to.x, y: to.y - dy / 2 },
        ];
  return `M ${r(from.x)} ${r(from.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(to.x)} ${r(to.y)}`;
}
const r = (n: number): number => Math.round(n * 10) / 10;

/**
 * A connection between two buckets. It runs from the center of one to the center of the other
 * (drawn beneath the buckets, so it seems to come out of them wherever they face each other). The
 * label sits halfway along the part that shows between the two.
 */
export function routeLink(a: Box, b: Box): { d: string; mid: Point; start: Point; end: Point } {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const exitA = edgePoint(a, cb).point;
  const exitB = edgePoint(b, ca).point;
  return {
    d: curveBetween(ca, cb),
    mid: { x: (exitA.x + exitB.x) / 2, y: (exitA.y + exitB.y) / 2 },
    start: { x: r(ca.x), y: r(ca.y) },
    end: { x: r(cb.x), y: r(cb.y) },
  };
}

/** A connection being drawn (or dragged) from a bucket's center to a loose point, such as the cursor. */
export function routeToPoint(a: Box, p: Point): string {
  return curveBetween(centerOf(a), p);
}

/** The map's grid: buckets snap to it when moved or resized (the dots on the background). */
export const GRID = 24;

export const snap = (v: number, grid = GRID): number => Math.round(v / grid) * grid;

/**
 * Resizing from the bottom-left corner, snapped to the grid: the left edge and the bottom edge
 * follow the pointer (moved by dx, dy), the right and top edges stay, and the box never gets smaller
 * than `min`.
 */
export function resizeFromBottomLeft(
  start: Box,
  dx: number,
  dy: number,
  min: { w: number; h: number },
  grid = GRID,
): { x: number; w: number; h: number } {
  const right = start.x + start.w;
  const left = Math.min(snap(start.x + dx, grid), right - min.w);
  const bottom = Math.max(snap(start.y + start.h + dy, grid), start.y + min.h);
  return { x: left, w: right - left, h: bottom - start.y };
}
