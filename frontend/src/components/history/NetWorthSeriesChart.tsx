import { LineChart } from "../charts/LineChart";
import { formatAxisMoney, formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { NetWorthSeries } from "../../types/data";

const NET_COLOR = "#2563eb";
const ASSET_COLOR = "#16a34a";
const DEBT_COLOR = "#dc2626";

/**
 * Net worth at the end of each day, week, or month. The line is continuous: where no balance was
 * recorded, an account's balance is rebuilt from its transactions, and a note says from when the
 * figures are recorded balances rather than rebuilt ones.
 */
export function NetWorthSeriesChart({
  series,
  breakdown,
  maxHeight,
}: {
  series: NetWorthSeries;
  /** Caps the chart's height in pixels, for a dashboard card. */
  maxHeight?: number;
  /** Also draw assets and debts as separate lines. */
  breakdown?: boolean;
}) {
  const money = (n: number) => formatMinor(n, series.currency);
  const lines = [
    {
      key: "net",
      label: "Net worth",
      color: NET_COLOR,
      points: series.points.map((p) => ({ date: p.date, value: p.netWorthMinor })),
    },
    ...(breakdown
      ? [
          {
            key: "assets",
            label: "Assets",
            color: ASSET_COLOR,
            points: series.points.map((p) => ({ date: p.date, value: p.assetsMinor })),
          },
          {
            key: "debts",
            label: "Debts",
            color: DEBT_COLOR,
            points: series.points.map((p) => ({ date: p.date, value: p.liabilitiesMinor })),
          },
        ]
      : []),
  ];
  const first = series.points[0];
  const rebuiltEarly =
    first !== undefined && series.recordedFrom !== null && first.date < series.recordedFrom;
  const anyRebuilt = series.points.some((p) => p.accounts.rebuilt > 0);
  const unit = series.granularity === "day" ? "day" : series.granularity;

  return (
    <div>
      <LineChart series={lines} format={money} formatAxis={formatAxisMoney} maxHeight={maxHeight} />
      <details className="mt-1 text-xs text-slate-500">
        <summary className="cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-300">
          ⓘ How this is worked out
        </summary>
        <ul className="mt-1 space-y-1">
          <li>
            Each point is your net worth at the end of the {unit}
            {series.granularity === "day" ? "" : " (the latest figure for one still going)"}.
          </li>
          {anyRebuilt && (
            <li>
              {rebuiltEarly && series.recordedFrom
                ? `Before ${formatDay(series.recordedFrom)}, `
                : "Where no balance was recorded, "}
              cash accounts and cards are rebuilt from their transactions, working back from a
              balance that was recorded. This is as complete as the transaction history the app has.
            </li>
          )}
          <li>
            Investments and loans use their last recorded balance until the next one. Before an
            account&apos;s first transaction or record it is held at the balance it started with,
            because what it was earlier is not known.
          </li>
        </ul>
      </details>
    </div>
  );
}
