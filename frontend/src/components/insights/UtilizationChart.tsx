import { LineChart } from "../charts/LineChart";
import { colorAt } from "../charts/palette";
import { ProgressBar } from "../charts/ProgressBar";
import { formatMinor } from "../../lib/money";
import { formatPercent, utilizationTone } from "../../lib/insights";
import type { UtilizationHistory } from "../../types/insights";

/**
 * How much of its limit each card is using now, and how that has moved over the days it was
 * recorded. Cards with no known limit are listed as such rather than guessed at.
 */
export function UtilizationChart({
  history,
  perCard,
}: {
  history: UtilizationHistory;
  /** Draw one line per card instead of the total. */
  perCard?: boolean;
}) {
  const money = (n: number) => formatMinor(n, history.currency);
  const latestTotal = history.total.at(-1) ?? null;
  const series = perCard
    ? history.cards
        .filter((c) => c.points.length > 0)
        .map((c, i) => ({
          key: String(c.accountId),
          label: c.name,
          color: c.color ?? colorAt(i),
          points: c.points.map((p) => ({ date: p.date, value: p.percent })),
        }))
    : [
        {
          key: "total",
          label: "All cards",
          color: colorAt(0),
          points: history.total.map((p) => ({ date: p.date, value: p.percent })),
        },
      ];
  const plotted = series.reduce((n, s) => n + s.points.length, 0);

  return (
    <div className="space-y-3">
      {latestTotal && (
        <div>
          <div className="text-xs text-slate-500">
            Using {money(latestTotal.balanceMinor)} of {money(latestTotal.limitMinor)}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {formatPercent(latestTotal.percent)}
            </span>
            <span
              className="text-sm font-medium"
              style={{ color: utilizationTone(latestTotal.percent).color }}
            >
              {utilizationTone(latestTotal.percent).label}
            </span>
          </div>
        </div>
      )}
      <ul className="space-y-2">
        {history.cards.map((c) => (
          <li key={c.accountId} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 text-slate-600 tabular-nums dark:text-slate-300">
                {c.latest
                  ? `${formatPercent(c.latest.percent)} · ${money(c.latest.balanceMinor)} of ${money(c.latest.limitMinor)}`
                  : "limit not known"}
              </span>
            </div>
            {c.latest && (
              <ProgressBar
                value={c.latest.percent}
                max={100}
                label={`${c.name} credit used`}
                color={utilizationTone(c.latest.percent).color}
              />
            )}
          </li>
        ))}
      </ul>
      {plotted >= 2 ? (
        <LineChart
          series={series}
          format={formatPercent}
          formatAxis={(n) => `${Math.round(n)}%`}
          gapDays={7}
        />
      ) : (
        <p className="text-xs text-slate-500">
          A chart appears once the balance has been recorded on two different days.
        </p>
      )}
    </div>
  );
}
