import { monthShort } from "../../lib/period";

export interface YearMonthRow {
  month: string;
  incomeMinor: number;
  spendingMinor: number;
  savedMinor: number;
  capsHeld: number;
  capsCount: number;
  netWorthMinor: number | null;
  partial: boolean;
}

/**
 * A year's months as rows, with income and spending as bars on one scale, so a table can be read for
 * exact figures and scanned for shape at once.
 */
export function YearMonthsTable({
  months,
  money,
  highest,
  lowest,
  compact = false,
}: {
  months: YearMonthRow[];
  money: (minor: number) => string;
  highest?: string | null;
  lowest?: string | null;
  compact?: boolean;
}) {
  const top = Math.max(1, ...months.flatMap((m) => [m.incomeMinor, m.spendingMinor]));
  const showCaps = !compact && months.some((m) => m.capsCount > 0);
  const showNetWorth = !compact && months.some((m) => m.netWorthMinor !== null);
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-slate-500">
        <tr>
          <th className="py-1 font-medium">Month</th>
          <th className="w-2/5 py-1 font-medium">In and out</th>
          <th className="py-1 text-right font-medium">Spent</th>
          <th className="py-1 text-right font-medium">Saved</th>
          {showCaps && <th className="py-1 text-right font-medium">Caps held</th>}
          {showNetWorth && <th className="py-1 text-right font-medium">Net worth</th>}
        </tr>
      </thead>
      <tbody>
        {months.map((m) => (
          <tr key={m.month} className="border-t border-slate-100 dark:border-slate-800">
            <td className="py-1 whitespace-nowrap">
              {monthShort(m.month)}
              {m.partial && <span className="ml-1 text-xs text-slate-500">so far</span>}
              {m.month === highest && <span className="ml-1 text-xs text-slate-500">highest</span>}
              {m.month === lowest && <span className="ml-1 text-xs text-slate-500">lowest</span>}
            </td>
            <td
              className="py-1 pr-3"
              title={`In ${money(m.incomeMinor)}, out ${money(m.spendingMinor)}`}
            >
              <div className="space-y-0.5" aria-hidden="true">
                <div
                  className="h-1.5 rounded-sm bg-green-600 dark:bg-green-400"
                  style={{ width: `${(m.incomeMinor / top) * 100}%` }}
                />
                <div
                  className="h-1.5 rounded-sm bg-red-500 dark:bg-red-400"
                  style={{ width: `${(m.spendingMinor / top) * 100}%` }}
                />
              </div>
            </td>
            <td className="py-1 text-right tabular-nums">{money(m.spendingMinor)}</td>
            <td
              className={`py-1 text-right tabular-nums ${m.savedMinor < 0 ? "text-red-700 dark:text-red-400" : ""}`}
            >
              {money(m.savedMinor)}
            </td>
            {showCaps && (
              <td className="py-1 text-right text-slate-600 tabular-nums dark:text-slate-300">
                {m.capsCount > 0 ? `${m.capsHeld} of ${m.capsCount}` : "None"}
              </td>
            )}
            {showNetWorth && (
              <td className="py-1 text-right tabular-nums">
                {m.netWorthMinor === null ? "None" : money(m.netWorthMinor)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
