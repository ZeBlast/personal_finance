import { LineChart } from "../charts/LineChart";
import { formatAxisMoney, formatMinor } from "../../lib/money";
import { formatDay } from "../../lib/time";
import type { NetWorthHistory } from "../../types/data";

/** The server marks a stretch with no recorded balance as a gap from this many days. */
export const GAP_DAYS = 7;

const NET_COLOR = "#2563eb";
const ASSET_COLOR = "#16a34a";
const DEBT_COLOR = "#dc2626";

/**
 * Net worth over the days balances were recorded. Dots are real observations, dashed stretches are
 * gaps where nothing was recorded, and a note says when early totals are missing accounts.
 */
export function NetWorthChart({
  history,
  breakdown,
}: {
  history: NetWorthHistory;
  /** Also draw assets and debts as separate lines. */
  breakdown?: boolean;
}) {
  const money = (n: number) => formatMinor(n, history.currency);
  const series = [
    {
      key: "net",
      label: "Net worth",
      color: NET_COLOR,
      points: history.points.map((p) => ({ date: p.date, value: p.netWorthMinor })),
    },
    ...(breakdown
      ? [
          {
            key: "assets",
            label: "Assets",
            color: ASSET_COLOR,
            points: history.points.map((p) => ({ date: p.date, value: p.assetsMinor })),
          },
          {
            key: "debts",
            label: "Debts",
            color: DEBT_COLOR,
            points: history.points.map((p) => ({ date: p.date, value: p.liabilitiesMinor })),
          },
        ]
      : []),
  ];
  const first = history.points[0];
  const incompleteEarly =
    first !== undefined &&
    (history.completeFrom === null || first.date < history.completeFrom) &&
    history.accountsTotal > 1;

  return (
    <div>
      <LineChart series={series} format={money} formatAxis={formatAxisMoney} gapDays={GAP_DAYS} />
      <ul className="mt-2 space-y-1 text-xs text-slate-500">
        <li>
          Dots are the days a balance was recorded (each sync, or each update by hand). Nothing is
          estimated between them.
        </li>
        {history.gaps.length > 0 && (
          <li>
            Dashed lines mark {history.gaps.length === 1 ? "a stretch" : "stretches"} with nothing
            recorded, the longest {Math.max(...history.gaps.map((g) => g.days))} days. Open the app
            or press Sync now to record more often.
          </li>
        )}
        {incompleteEarly && (
          <li>
            {history.completeFrom ? `Before ${formatDay(history.completeFrom)}` : "So far"},{" "}
            {history.completeFrom
              ? "some accounts had not been recorded yet"
              : "not every account has been recorded"}
            , so those totals are lower than your real net worth was.
          </li>
        )}
      </ul>
    </div>
  );
}
