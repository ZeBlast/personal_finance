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

const STATUS_WATER: Record<CapStatus, [string, string]> = {
  ok: ["#60a5fa", "#2563eb"],
  full: ["#60a5fa", "#2563eb"],
  risk: ["#fbbf24", "#d97706"],
  over: ["#f87171", "#dc2626"],
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
const BODY = `M${LEFT},${rimY}A${rimHalfWidth},12 0 0 1 ${RIGHT},${rimY}L${100 + bottomHalfWidth},${bottomY}A${bottomHalfWidth},12 0 0 1 ${100 - bottomHalfWidth},${bottomY}Z`;
const ribAt = (y: number): string => {
  const half = bucketHalfWidth(y);
  return `M${100 - half},${y}A${half},11 0 0 0 ${100 + half},${y}`;
};

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
  const [light, deep] = color ? [color, color] : STATUS_WATER[status];
  const surfaceScale = bucketHalfWidth(y) / rimHalfWidth;
  const paceFill = expectedMinor === null ? null : bucketFill(expectedMinor, capMinor);
  const paceY = paceFill === null ? null : waterY(paceFill);
  const over = overflow > 0;

  return (
    <svg
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(capMinor, spentMinor, 1)}
      aria-valuenow={Math.max(0, spentMinor)}
      aria-valuetext={description}
      viewBox="0 -6 200 232"
      className="pf-bucket h-full max-h-full w-full"
    >
      <title>{description}</title>
      <defs>
        <clipPath id={`${id}-inside`}>
          <path d={BODY} />
        </clipPath>
        <linearGradient id={`${id}-water`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={deep} />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="0.28" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="0.72" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.16" />
        </linearGradient>
      </defs>

      {/* The puddle, growing with how far past the cap spending is. */}
      {over && (
        <ellipse
          data-testid="bucket-puddle"
          cx="100"
          cy="214"
          rx={60 + overflow * 36}
          ry={6 + overflow * 4}
          fill={deep}
          fillOpacity="0.4"
          className="pf-bucket-puddle"
        />
      )}

      {/* The handle, hanging behind the rim, and the inside of the far wall. */}
      <path
        key={`handle-${drop}`}
        d={`M${LEFT},${rimY}C${LEFT},-20 ${RIGHT},-20 ${RIGHT},${rimY}`}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        className={`stroke-slate-400 dark:stroke-slate-500 ${drop > 0 ? "pf-bucket-sway" : ""}`}
      />
      <ellipse
        cx="100"
        cy={rimY}
        rx={rimHalfWidth}
        ry="12"
        className="fill-slate-300 dark:fill-slate-700"
      />
      <path d={BODY} className="fill-slate-100 dark:fill-slate-800" />

      {/* The water. */}
      <g clipPath={`url(#${id}-inside)`}>
        <g className="pf-bucket-level" style={{ transform: `translateY(${y}px)` }}>
          <path
            d={wavePath(5)}
            fill={deep}
            fillOpacity="0.55"
            className="pf-bucket-wave pf-bucket-wave-back"
          />
        </g>
        <g
          className="pf-bucket-level"
          style={{
            transform: `translate(100px, ${y}px) scaleX(${surfaceScale})`,
            opacity: shown > 0 ? 1 : 0,
          }}
        >
          <ellipse rx={rimHalfWidth} ry="7" fill={light} fillOpacity="0.85" />
          {drop > 0 && (
            <ellipse
              key={`ripple-${drop}`}
              data-testid="bucket-ripple"
              rx="22"
              ry="3.5"
              fill="none"
              stroke="#fff"
              strokeWidth="1.5"
              className="pf-bucket-ripple"
            />
          )}
        </g>
        <g className="pf-bucket-level" style={{ transform: `translateY(${y + 4}px)` }}>
          <path
            d={wavePath(4)}
            fill={`url(#${id}-water)`}
            fillOpacity="0.9"
            className="pf-bucket-wave"
          />
        </g>
      </g>

      {/* A new purchase, falling in. */}
      {drop > 0 && (
        <path
          key={`drop-${drop}`}
          data-testid="bucket-drop"
          d="M100,-9C104,-3 106,0 106,3A6,6 0 0 1 94,3C94,0 96,-3 100,-9Z"
          fill={light}
          className="pf-bucket-drop"
          style={{ "--pf-drop-to": `${y - 2}px` } as CSSProperties}
        />
      )}

      {/* The bucket's outside: metal shine, ribs, and how full it is at a glance. */}
      <path d={BODY} fill={`url(#${id}-shine)`} />
      <path d={ribAt(92)} fill="none" className="stroke-slate-400/60 dark:stroke-slate-500/60" />
      <path d={ribAt(168)} fill="none" className="stroke-slate-400/60 dark:stroke-slate-500/60" />
      {[0.25, 0.5, 0.75].map((f) => {
        const at = waterY(f);
        const right = 100 + bucketHalfWidth(at);
        return (
          <line
            key={f}
            x1={right - 12}
            x2={right - 2}
            y1={at}
            y2={at}
            strokeWidth="1.5"
            className="stroke-slate-500/70 dark:stroke-slate-300/70"
          />
        );
      })}
      {paceY !== null && (
        <path
          data-testid="bucket-pace"
          d={`M${100 - bucketHalfWidth(paceY) - 9},${paceY - 5}l9,5l-9,5Z`}
          className="pf-bucket-level fill-slate-600 dark:fill-slate-300"
        />
      )}
      <path
        d={`M${LEFT},${rimY}L${100 - bottomHalfWidth},${bottomY}A${bottomHalfWidth},12 0 0 0 ${100 + bottomHalfWidth},${bottomY}L${RIGHT},${rimY}`}
        fill="none"
        strokeWidth="2.5"
        strokeLinejoin="round"
        className="stroke-slate-500 dark:stroke-slate-400"
      />

      {/* Past the cap, it runs over the sides. */}
      {over && (
        <g
          data-testid="bucket-spill"
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          stroke={deep}
        >
          <path
            className="pf-bucket-spill"
            d={`M${LEFT - 3},${rimY + 3}L${100 - bottomHalfWidth - 4},214`}
          />
          <path
            className="pf-bucket-spill pf-bucket-spill-late"
            d={`M${RIGHT + 3},${rimY + 3}L${100 + bottomHalfWidth + 4},214`}
          />
        </g>
      )}

      {/* The rim, in front of everything, with the handle's fixings. */}
      <path
        d={`M${LEFT},${rimY}A${rimHalfWidth},12 0 0 0 ${RIGHT},${rimY}`}
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        className="stroke-slate-500 dark:stroke-slate-400"
      />
      <ellipse
        cx="100"
        cy={rimY}
        rx={rimHalfWidth}
        ry="12"
        fill="none"
        strokeWidth="1.5"
        className="stroke-slate-500 dark:stroke-slate-400"
      />
      <circle cx={LEFT} cy={rimY} r="4" className="fill-slate-500 dark:fill-slate-400" />
      <circle cx={RIGHT} cy={rimY} r="4" className="fill-slate-500 dark:fill-slate-400" />
    </svg>
  );
}
