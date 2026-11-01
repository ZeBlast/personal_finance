import { useNavigate } from "react-router-dom";
import { useMeasuredWidth } from "../../hooks/useMeasuredWidth";
import { summaryPath } from "../../lib/analytics";
import { firstOfMonth, lastOfMonth } from "../../lib/period";
import {
  cashFlowModel,
  spreadLabels,
  stackColumn,
  type FlowBand,
  type FlowRow,
} from "../../lib/views";
import { colorAt } from "../charts/palette";

/** The summary a month's map is drawn from. */
export const cashFlowPath = (month: string): string =>
  summaryPath({
    from: firstOfMonth(month),
    to: lastOfMonth(month),
    groupBy: "category",
    rollupToParent: true,
  });

const SAVED = "#16a34a";
const NEUTRAL = "#94a3b8";
const LABEL_HEIGHT = 18;

function bandColor(band: FlowBand, index: number): string {
  if (band.kind === "saved") return SAVED;
  if (band.kind === "other" || band.kind === "shortfall") return NEUTRAL;
  if (band.kind === "source") return band.color ?? NEUTRAL;
  return band.color ?? colorAt(index);
}

/**
 * A curved band from one bar to the middle. Both ends keep the band's share of the money, so the
 * widths add up along the way. Pure.
 */
export function flowPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
): string {
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1}C${mid},${y1} ${mid},${y2} ${x2},${y2}V${y2 + thickness}C${mid},${y2 + thickness} ${mid},${y1 + thickness} ${x1},${y1 + thickness}Z`;
}

/**
 * Where a month's money came from and went: income on the left, categories on the right, and what
 * was saved, or what came from savings, so both sides add up. Click a category for its transactions.
 */
export function CashFlowMap({
  rows,
  month,
  money,
  height = 360,
}: {
  rows: FlowRow[];
  month: string;
  money: (minor: number) => string;
  height?: number;
}) {
  const navigate = useNavigate();
  const { ref, width } = useMeasuredWidth();
  const model = cashFlowModel(rows);
  if (model.totalMinor === 0) {
    return (
      <p ref={ref} className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        Nothing came in or went out this month.
      </p>
    );
  }
  const narrow = width < 620;
  const labelWidth = narrow ? 110 : 200;
  const barWidth = 10;
  const gap = 8;
  const top = 8;
  // Tall enough that every label has its own line.
  const drawn = Math.max(
    height,
    (Math.max(model.sources.length, model.targets.length) + 1) * LABEL_HEIGHT + top * 2,
  );
  const plot = drawn - top * 2;
  const leftX = labelWidth;
  const rightX = Math.max(leftX + 80, width - labelWidth - barWidth);
  // Income is usually one or two large bands: the room goes to where the money splits up.
  const centreX = leftX + barWidth + (rightX - leftX - barWidth) * 0.25;
  const sources = stackColumn(model.sources, model.totalMinor, plot, gap);
  const targets = stackColumn(model.targets, model.totalMinor, plot, gap);
  const sourceLabels = spreadLabels(
    sources.map((s) => s.y + s.height / 2),
    LABEL_HEIGHT,
    plot,
  );
  const targetLabels = spreadLabels(
    targets.map((t) => t.y + t.height / 2),
    LABEL_HEIGHT,
    plot,
  );
  const open = (band: FlowBand) => {
    if (band.kind !== "category") return;
    const query = new URLSearchParams({
      category: band.key === "0" ? "none" : band.key,
      from: firstOfMonth(month),
      to: lastOfMonth(month),
    });
    navigate(`/transactions?${query.toString()}`);
  };

  // Where each band meets the middle bar: stacked in order with no gaps.
  const scale = plot / model.totalMinor;
  const centre = (bands: FlowBand[]): number[] => {
    const total = bands.reduce((sum, b) => sum + b.amountMinor, 0) * scale;
    let y = top + (plot - total) / 2;
    return bands.map((b) => {
      const at = y;
      y += b.amountMinor * scale;
      return at;
    });
  };
  const fromCentre = centre(sources);
  const toCentre = centre(targets);
  const short = (label: string): string =>
    narrow && label.length > 13 ? `${label.slice(0, 12)}…` : label;

  return (
    <div ref={ref}>
      <svg
        role="img"
        aria-label={`Money in ${money(model.incomeMinor)}, money out ${money(model.spendingMinor)}. ${targets.map((t) => `${t.label} ${money(t.amountMinor)}`).join(", ")}.`}
        width={width}
        height={drawn}
        className="pf-reveal-x block"
      >
        {sources.map((s, i) => (
          <g key={s.key}>
            <title>{`${s.label}: ${money(s.amountMinor)}`}</title>
            <path
              d={flowPath(
                leftX + barWidth,
                top + s.y,
                centreX,
                fromCentre[i]!,
                s.amountMinor * scale,
              )}
              fill={bandColor(s, i)}
              fillOpacity={0.16}
            />
            <rect
              x={leftX}
              y={top + s.y}
              width={barWidth}
              height={s.height}
              rx={2}
              fill={bandColor(s, i)}
            />
            <text
              x={leftX - 8}
              y={top + sourceLabels[i]! + 4}
              textAnchor="end"
              className="fill-slate-900 text-xs dark:fill-slate-100"
            >
              {short(s.label)}{" "}
              <tspan className="fill-slate-500 tabular-nums dark:fill-slate-400">
                {money(s.amountMinor)}
              </tspan>
            </text>
          </g>
        ))}
        {targets.map((t, i) => (
          <g
            key={t.key}
            onClick={() => open(t)}
            className={t.kind === "category" ? "cursor-pointer" : undefined}
          >
            <title>
              {`${t.label}: ${money(t.amountMinor)}${t.kind === "category" ? ". Click for its transactions." : ""}`}
            </title>
            <path
              d={flowPath(centreX, toCentre[i]!, rightX, top + t.y, t.amountMinor * scale)}
              fill={bandColor(t, i)}
              fillOpacity={0.28}
            />
            <rect
              x={rightX}
              y={top + t.y}
              width={barWidth}
              height={t.height}
              rx={2}
              fill={bandColor(t, i)}
            />
            <text
              x={rightX + barWidth + 8}
              y={top + targetLabels[i]! + 4}
              className="fill-slate-900 text-xs dark:fill-slate-100"
            >
              {short(t.label)}{" "}
              <tspan className="fill-slate-500 tabular-nums dark:fill-slate-400">
                {money(t.amountMinor)}
              </tspan>
            </text>
          </g>
        ))}
        <rect
          x={centreX - 1.5}
          y={top + (plot - model.totalMinor * scale) / 2}
          width={3}
          height={model.totalMinor * scale}
          rx={1.5}
          className="fill-slate-300 dark:fill-slate-600"
        />
      </svg>
    </div>
  );
}
