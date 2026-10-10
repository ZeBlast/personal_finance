import { allocationTotal, evenSplit, type AllocationRow, type TspFund } from "../../lib/tsp";
import { buttonClass, inputClass } from "./styles";

/**
 * Chooses which funds new money goes into and what share each gets. The shares must add up to
 * exactly 100%.
 */
export function AllocationEditor({
  funds,
  rows,
  onChange,
  idPrefix,
}: {
  funds: TspFund[];
  rows: AllocationRow[];
  onChange: (rows: AllocationRow[]) => void;
  idPrefix: string;
}) {
  const total = allocationTotal(rows);
  const used = new Set(rows.map((r) => r.symbol));
  const update = (index: number, change: Partial<AllocationRow>): void =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-xs font-medium" htmlFor={`${idPrefix}-fund-${index}`}>
              Fund
            </label>
            <select
              id={`${idPrefix}-fund-${index}`}
              value={row.symbol}
              onChange={(e) => update(index, { symbol: e.target.value })}
              className={inputClass}
            >
              <option value="">Choose a fund</option>
              {funds
                .filter((f) => f.symbol === row.symbol || !used.has(f.symbol))
                .map((f) => (
                  <option key={f.symbol} value={f.symbol}>
                    {f.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="w-24">
            <label className="block text-xs font-medium" htmlFor={`${idPrefix}-pct-${index}`}>
              Share %
            </label>
            <input
              id={`${idPrefix}-pct-${index}`}
              inputMode="decimal"
              value={row.percent}
              placeholder="50"
              onChange={(e) => update(index, { percent: e.target.value })}
              className={inputClass}
            />
          </div>
          <button
            type="button"
            className={buttonClass}
            aria-label={`Remove fund ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={rows.length >= funds.length}
          onClick={() => onChange([...rows, { symbol: "", percent: "" }])}
        >
          Add a fund
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={rows.length === 0}
          onClick={() => onChange(evenSplit(rows.map((r) => r.symbol)))}
        >
          Split evenly
        </button>
        <span
          aria-live="polite"
          className={`ml-auto text-sm font-medium tabular-nums ${
            total === 100
              ? "text-green-700 dark:text-green-400"
              : "text-amber-700 dark:text-amber-400"
          }`}
        >
          Total {total}%{total === 100 ? "" : " (must be 100%)"}
        </span>
      </div>
    </div>
  );
}
