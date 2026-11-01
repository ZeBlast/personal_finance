import { AlertTriangle, Check, CircleDot, TrendingUp } from "lucide-react";
import { STATUS_WORD, historyWords } from "../../lib/caps";
import type { Budget, CapStatus } from "../../types/analytics";

const OVER_STRIPES = "repeating-linear-gradient(135deg, #dc2626 0 4px, #f87171 4px 7px)";

/**
 * Spending against a cap. The bar is what has been spent; past the cap line it turns striped red. In
 * the current month a paler bar shows where the month looks set to end, and a small mark shows where
 * an even pace would be today.
 */
export function CapMeter({
  spentMinor,
  capMinor,
  expectedMinor = null,
  projectedMinor = null,
  color,
  label,
  description,
}: {
  spentMinor: number;
  capMinor: number;
  expectedMinor?: number | null;
  projectedMinor?: number | null;
  color: string | null;
  label: string;
  /** The meter's reading, in words, for screen readers and on hover. */
  description: string;
}) {
  const cap = Math.max(0, capMinor);
  const spent = Math.max(0, spentMinor);
  const domain = Math.max(cap, spent, projectedMinor ?? 0, 1);
  const at = (minor: number): string => `${(Math.min(minor, domain) / domain) * 100}%`;
  const fill = color ?? "#2563eb";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={domain}
      aria-valuenow={Math.min(spent, domain)}
      aria-valuetext={description}
      title={description}
      className="relative h-4"
    >
      <div className="absolute inset-x-0 top-1 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        {projectedMinor !== null && projectedMinor > spent && (
          <div
            className="absolute inset-y-0 left-0 opacity-30 transition-[width] duration-500"
            style={{ width: at(projectedMinor), backgroundColor: fill }}
          />
        )}
        <div
          className="pf-grow-x absolute inset-y-0 left-0 transition-[width] duration-500"
          style={{ width: at(Math.min(spent, cap)), backgroundColor: fill }}
        />
        {spent > cap && (
          <div
            className="absolute inset-y-0 transition-[left,width] duration-500"
            style={{ left: at(cap), width: at(spent - cap), backgroundImage: OVER_STRIPES }}
          />
        )}
      </div>
      {/* The cap itself, drawn only once something runs past it. */}
      {domain > cap && (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-slate-800 transition-[left] duration-500 dark:bg-slate-100"
          style={{ left: at(cap) }}
        />
      )}
      {expectedMinor !== null && (
        <div
          aria-hidden="true"
          data-testid="pace-mark"
          className="absolute top-0 h-1.5 w-0.5 -translate-x-1/2 bg-slate-500 transition-[left] duration-500 dark:bg-slate-300"
          style={{ left: at(expectedMinor) }}
        />
      )}
    </div>
  );
}

const STATUS_LOOK: Record<CapStatus, { Icon: typeof Check; className: string }> = {
  over: { Icon: AlertTriangle, className: "text-red-700 dark:text-red-400" },
  risk: { Icon: TrendingUp, className: "text-amber-700 dark:text-amber-400" },
  full: { Icon: CircleDot, className: "text-slate-600 dark:text-slate-300" },
  ok: { Icon: Check, className: "text-green-700 dark:text-green-400" },
};

/** A cap's state as an icon and a word, so it is never told by color alone. */
export function CapStatusLabel({ status }: { status: CapStatus }) {
  const { Icon, className } = STATUS_LOOK[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${className}`}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {STATUS_WORD[status]}
    </span>
  );
}

/** A cap's last six months: a bar for each, red where it went over, with the cap marked above. */
export function CapHistoryChart({ history }: { history: NonNullable<Budget["history"]> }) {
  const width = 90;
  const height = 26;
  const gap = 3;
  const barWidth = (width - gap * (history.length - 1)) / Math.max(1, history.length);
  const top = Math.max(1, ...history.flatMap((h) => [h.spentMinor, h.capMinor ?? 0]));
  const y = (minor: number) => height - (Math.max(0, minor) / top) * (height - 1);
  return (
    <svg
      role="img"
      aria-label={historyWords(history)}
      width={width}
      height={height}
      className="shrink-0"
    >
      <title>{historyWords(history)}</title>
      {history.map((h, i) => {
        const x = i * (barWidth + gap);
        const over = h.capMinor !== null && h.spentMinor > h.capMinor;
        return (
          <g key={h.month}>
            <rect
              x={x}
              y={y(h.spentMinor)}
              width={barWidth}
              height={height - y(h.spentMinor)}
              rx={1.5}
              className={`pf-grow-up ${over ? "fill-red-500" : "fill-slate-300 dark:fill-slate-600"}`}
            />
            {h.capMinor !== null && (
              <line
                x1={x - 1}
                x2={x + barWidth + 1}
                y1={y(h.capMinor)}
                y2={y(h.capMinor)}
                strokeWidth={1.5}
                className="stroke-slate-800 dark:stroke-slate-100"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
