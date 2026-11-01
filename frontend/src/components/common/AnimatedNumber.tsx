import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion, tween } from "../../lib/motion";

const DURATION_MS = 600;

/**
 * A figure that counts to its new value when the data changes, so a change is seen happening. The
 * first value shows straight away: nothing counts up just because a page opened.
 */
export function AnimatedNumber({
  value,
  format,
}: {
  value: number;
  format: (value: number) => string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    if (from.current === value) return;
    if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = (now - began) / DURATION_MS;
      const next = t >= 1 ? value : Math.round(tween(start, value, t));
      from.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    // Animation frames pause in a hidden window: a figure must still land on the real value.
    const landed = setTimeout(() => {
      cancelAnimationFrame(frame);
      from.current = value;
      setShown(value);
    }, DURATION_MS + 100);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(landed);
    };
  }, [value]);

  // Screen readers get the real value only, not every step on the way there.
  return (
    <span aria-label={format(value)} className="tabular-nums">
      <span aria-hidden="true">{format(shown)}</span>
    </span>
  );
}
