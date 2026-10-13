import { useApi } from "../../hooks/useApi";
import { useDateBasis } from "../../hooks/useDateBasis";
import { formatMinor } from "../../lib/money";
import { firstOfMonth, lastOfMonth } from "../../lib/period";
import type { PeriodSummary } from "../../types/calendar";
import { MONTH_NAMES, splitMonth } from "./range";

/**
 * The shown month at a glance: what was spent and earned, what is still expected, and where cash
 * minus cards ends up. Only the month's own days count (not the neighbouring days in the grid),
 * and the display filters never change it.
 */
export function MonthOverview({
  month,
  accountId,
  accountName,
}: {
  month: string;
  accountId: string;
  accountName: string | null;
}) {
  const basis = useDateBasis();
  const q = new URLSearchParams({
    from: firstOfMonth(month),
    to: lastOfMonth(month),
    dateBasis: basis,
  });
  if (accountId) q.set("accountId", accountId);
  const { data: s, error } = useApi<PeriodSummary>(`/calendar/summary?${q}`);
  const { monthIndex } = splitMonth(month);
  const scope = `${accountName ?? "All accounts"} · by ${basis === "posted" ? "posted" : "transaction"} date`;

  if (error) {
    return (
      <p role="alert" className="mb-2 text-xs text-red-600">
        The month overview could not load: {error}
      </p>
    );
  }
  if (!s) return <div className="mb-2 h-[3.25rem]" aria-hidden="true" />;
  const c = s.currency;
  const end = s.balance.endMinor;
  return (
    <section
      aria-label={`${MONTH_NAMES[monthIndex]} overview`}
      className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-700"
    >
      <Item label="Spent" value={formatMinor(s.spendingMinor, c)} />
      <Item label="Income" value={formatMinor(s.incomeMinor, c)} tone="good" />
      {s.expected.count > 0 && (
        <Item
          label="Still expected"
          value={[
            s.expected.outflowMinor > 0 ? `−${formatMinor(s.expected.outflowMinor, c)}` : null,
            s.expected.inflowMinor > 0 ? `+${formatMinor(s.expected.inflowMinor, c)}` : null,
          ]
            .filter(Boolean)
            .join(" / ")}
          tone="expected"
        />
      )}
      <Item
        label={
          s.balance.projected
            ? "Cash minus cards at month end (projected)"
            : "Cash minus cards at month end"
        }
        value={end === null ? "Not known" : formatMinor(end, c)}
      />
      <span
        className="ml-auto text-xs text-slate-500 dark:text-slate-400"
        title="The overview counts everything in this scope; display filters do not change it."
      >
        {MONTH_NAMES[monthIndex]} · {scope}
      </span>
    </section>
  );
}

function Item({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "expected";
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span
        className={`font-semibold tabular-nums ${
          tone === "good"
            ? "text-green-700 dark:text-green-400"
            : tone === "expected"
              ? "text-violet-700 dark:text-violet-300"
              : ""
        }`}
      >
        {value}
      </span>
    </span>
  );
}
