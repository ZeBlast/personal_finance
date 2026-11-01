/** Whether the user has asked their computer for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Where a value is, `t` of the way (0 to 1) from one figure to another, slowing at the end. Pure. */
export function tween(from: number, to: number, t: number): number {
  const progress = Math.max(0, Math.min(1, t));
  return from + (to - from) * (1 - (1 - progress) ** 3);
}

// ---- The spending bucket -----------------------------------------------------------------------

/** How full a bucket is, 0 to 1. Spending past the cap overflows rather than filling further. Pure. */
export function bucketFill(spentMinor: number, capMinor: number): number {
  if (spentMinor <= 0) return 0;
  if (capMinor <= 0) return 1;
  return Math.min(1, spentMinor / capMinor);
}

/** How far past the cap spending is, 0 to 1 (at twice the cap), for the size of the puddle. Pure. */
export function bucketOverflow(spentMinor: number, capMinor: number): number {
  if (spentMinor <= capMinor) return 0;
  if (capMinor <= 0) return 1;
  return Math.min(1, (spentMinor - capMinor) / capMinor);
}

export const BUCKET = {
  rimY: 54,
  bottomY: 196,
  rimHalfWidth: 70,
  bottomHalfWidth: 52,
  /** Water at these heights is out of sight below the base, and just under the rim. */
  emptyY: 212,
  fullY: 62,
} as const;

/** The height of the water's surface in the drawing, for a fill from 0 to 1. Pure. */
export const waterY = (fill: number): number =>
  BUCKET.emptyY - fill * (BUCKET.emptyY - BUCKET.fullY);

/** The bucket's half width at a height, narrowing from the rim to the base. Pure. */
export function bucketHalfWidth(y: number): number {
  const down = (y - BUCKET.rimY) / (BUCKET.bottomY - BUCKET.rimY);
  const clamped = Math.max(0, Math.min(1, down));
  return BUCKET.rimHalfWidth - clamped * (BUCKET.rimHalfWidth - BUCKET.bottomHalfWidth);
}
