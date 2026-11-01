import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  bucketFill,
  bucketHalfWidth,
  bucketOverflow,
  BUCKET,
  prefersReducedMotion,
  waterY,
} from "../../lib/motion";
import type { CapStatus } from "../../types/analytics";

/** The app's own colours for how a cap stands, flat like its other charts. */
const STATUS_WATER: Record<CapStatus, { fill: string; stroke: string }> = {
  ok: { fill: "fill-blue-600", stroke: "stroke-blue-600" },
  full: { fill: "fill-blue-600", stroke: "stroke-blue-600" },
  risk: { fill: "fill-amber-500", stroke: "stroke-amber-500" },
  over: { fill: "fill-red-600", stroke: "stroke-red-600" },
};

/** One wave repeated for wider than the bucket, with room to slide sideways forever. */
const WAVE_PERIOD = 80;
const wavePath = (height: number): string => {
  const humps = Array.from({ length: 6 }, () => `t${WAVE_PERIOD / 2},0`).join("");
  return `M-${WAVE_PERIOD},0q${WAVE_PERIOD / 4},${-height} ${WAVE_PERIOD / 2},0${humps}V260H-${WAVE_PERIOD}Z`;
};

const { rimY, bottomY, rimHalfWidth, bottomHalfWidth } = BUCKET;
const LEFT = 100 - rimHalfWidth;
const RIGHT = 100 + rimHalfWidth;
const BASE_LEFT = 100 - bottomHalfWidth;
const BASE_RIGHT = 100 + bottomHalfWidth;
/** A straight-sided pail with rounded bottom corners. */
const BODY = `M${LEFT},${rimY}L${BASE_LEFT - 1},${bottomY - 7}Q${BASE_LEFT},${bottomY} ${BASE_LEFT + 7},${bottomY}H${BASE_RIGHT - 7}Q${BASE_RIGHT},${bottomY} ${BASE_RIGHT + 1},${bottomY - 7}L${RIGHT},${rimY}Z`;

/**
 * Spending as water in a bucket: the rim is the cap. The water rises to its level when shown, moves
 * when spending changes (a new purchase falls in as a drop), and past the cap it runs over the sides
 * into a puddle that grows with how far over it is. With reduced motion it is the same picture, still.
 */
export function SpendingBucket({
  spentMinor,
  capMinor,
  expectedMinor = null,
  status,
  color = null,
  label,
  description,
}: {
  spentMinor: number;
  capMinor: number;
  /** An even pace for today, marked on the side. */
  expectedMinor?: number | null;
  status: CapStatus;
  /** A fixed water colour; otherwise the colour follows how the cap stands. */
  color?: string | null;
  label: string;
  description: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const fill = bucketFill(spentMinor, capMinor);
  const overflow = bucketOverflow(spentMinor, capMinor);
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? fill : 0));
  const [drop, setDrop] = useState(0);
  const lastSpent = useRef(spentMinor);

  // Rises to its level just after it first paints, and follows the figure after that.
  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") {
      setShown(fill);
      return;
    }
    const frame = requestAnimationFrame(() => setShown(fill));
    return () => cancelAnimationFrame(frame);
  }, [fill]);

  // More spending falls in as a drop.
  useEffect(() => {
    if (spentMinor > lastSpent.current && !prefersReducedMotion()) setDrop((n) => n + 1);
    lastSpent.current = spentMinor;
  }, [spentMinor]);

  const y = waterY(shown);
  // A chosen colour is set directly; otherwise the class follows how the cap stands.
  const water = color
    ? { fill: undefined, stroke: undefined, paint: color }
    : { ...STATUS_WATER[status], paint: undefined };
  const paceFill = expectedMinor === null ? null : bucketFill(expectedMinor, capMinor);
  const paceY = paceFill === null ? null : waterY(paceFill);
  const over = overflow > 0;
  const puddleWidth = 110 + overflow * 70;

  return (
    <svg
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(capMinor, spentMinor, 1)}
      aria-valuenow={Math.max(0, spentMinor)}
      aria-valuetext={description}
      viewBox="0 0 200 220"
      className="pf-bucket h-full max-h-full w-full"
    >
      <title>{description}</title>
      <defs>
        <clipPath id={`${id}-inside`}>
          <path d={BODY} />
        </clipPath>
      </defs>

      {/* The handle, then the empty pail. */}
      <path
        key={`handle-${drop}`}
        d={`M${LEFT + 6},${rimY - 4}C${LEFT + 6},-12 ${RIGHT - 6},-12 ${RIGHT - 6},${rimY - 4}`}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        className={`stroke-slate-300 dark:stroke-slate-600 ${drop > 0 ? "pf-bucket-sway" : ""}`}
      />
      <path d={BODY} className="fill-slate-200 dark:fill-slate-700" />

      {/* The water: a paler wave behind a solid one. */}
      <g clipPath={`url(#${id}-inside)`}>
        <g className="pf-bucket-level" style={{ transform: `translateY(${y - 3}px)` }}>
          <path
            d={wavePath(5)}
            fill={water.paint}
            fillOpacity="0.4"
            className={`pf-bucket-wave pf-bucket-wave-back ${water.fill ?? ""}`}
          />
        </g>
        <g className="pf-bucket-level" style={{ transform: `translateY(${y}px)` }}>
          <path
            d={wavePath(4)}
            fill={water.paint}
            className={`pf-bucket-wave ${water.fill ?? ""}`}
          />
        </g>
        {drop > 0 && (
          <g className="pf-bucket-level" style={{ transform: `translate(100px, ${y - 2}px)` }}>
            <line
              key={`ripple-${drop}`}
              data-testid="bucket-ripple"
              x1="-20"
              x2="20"
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
              className="pf-bucket-ripple"
            />
          </g>
        )}
      </g>

      {/* A new purchase, falling in. */}
      {drop > 0 && (
        <path
          key={`drop-${drop}`}
          data-testid="bucket-drop"
          d="M100,-4C104,2 106,5 106,8A6,6 0 0 1 94,8C94,5 96,2 100,-4Z"
          fill={water.paint}
          className={`pf-bucket-drop ${water.fill ?? ""}`}
          style={{ "--pf-drop-to": `${y - 8}px` } as CSSProperties}
        />
      )}

      {/* Quarter marks, and an even pace for today. */}
      {[0.25, 0.5, 0.75].map((f) => {
        const at = waterY(f);
        const right = 100 + bucketHalfWidth(at);
        return (
          <line
            key={f}
            x1={right - 11}
            x2={right - 2}
            y1={at}
            y2={at}
            strokeWidth="2"
            strokeLinecap="round"
            className="stroke-slate-400 dark:stroke-slate-500"
          />
        );
      })}
      {paceY !== null && (
        <path
          data-testid="bucket-pace"
          d={`M${100 - bucketHalfWidth(paceY) - 9},${paceY - 5}l8,5l-8,5Z`}
          className="pf-bucket-level fill-slate-500 dark:fill-slate-400"
        />
      )}

      {/* The rim. */}
      <rect
        x={LEFT - 6}
        y={rimY - 5}
        width={rimHalfWidth * 2 + 12}
        height="9"
        rx="4.5"
        className="fill-slate-400 dark:fill-slate-500"
      />

      {/* Past the cap, it runs over the sides and collects underneath. */}
      {over && (
        <>
          <g
            data-testid="bucket-spill"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            stroke={water.paint}
            className={water.stroke}
          >
            <path className="pf-bucket-spill" d={`M${LEFT - 4},${rimY + 5}L${BASE_LEFT - 5},206`} />
            <path
              className="pf-bucket-spill pf-bucket-spill-late"
              d={`M${RIGHT + 4},${rimY + 5}L${BASE_RIGHT + 5},206`}
            />
          </g>
          <rect
            data-testid="bucket-puddle"
            x={100 - puddleWidth / 2}
            y="208"
            width={puddleWidth}
            height="7"
            rx="3.5"
            fill={water.paint}
            fillOpacity="0.45"
            className={`pf-bucket-puddle ${water.fill ?? ""}`}
          />
        </>
      )}
    </svg>
  );
}
