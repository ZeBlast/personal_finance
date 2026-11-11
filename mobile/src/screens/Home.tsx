import { formatMinor } from "../../../frontend/src/lib/money";
import { addDays, ago, caps, dayLabel, isStale, overview, syncItems, upcoming } from "../lib/data";
import type { Snapshot } from "../lib/snapshot";
import { Card, Meter, Notice, Page } from "./ui";

export function HomeScreen({
  snapshot,
  source,
  problem,
  now = new Date(),
}: {
  snapshot: Snapshot;
  source: "file" | "cache";
  problem: string | null;
  now?: Date;
}) {
  const body = snapshot.body;
  const totals = overview(snapshot);
  const currency = totals?.currency ?? "USD";
  const month = caps(snapshot);
  const weekEnd = addDays(body.today, 7);
  const soon = upcoming(snapshot)
    .filter((e) => e.status === "expected" && e.date <= weekEnd)
    .sort((a, b) => a.date.localeCompare(b.date));
  const needSignIn = syncItems(snapshot).filter((i) => i.connectionStatus !== "active");

  return (
    <Page title="Home">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        From your PC, {ago(body.createdAt, now)}
        {source === "cache" ? " (the last copy on this phone)" : ""}.
      </p>
      {problem && <Notice kind="warning">{problem}</Notice>}
      {isStale(body.createdAt, now) && (
        <Notice kind="warning">
          This is more than two days old. Open the app on your PC to sync, and check that Google
          Drive is syncing.
        </Notice>
      )}
      {needSignIn.length > 0 && (
        <Notice kind="warning">
          Sign in again on the PC: {needSignIn.map((i) => i.institutionName).join(", ")}.
        </Notice>
      )}

      {totals && (
        <Card>
          <p className="text-sm text-slate-500 dark:text-slate-400">Net worth</p>
          <p className="text-3xl font-semibold tabular-nums">
            {formatMinor(totals.netWorthMinor, currency)}
          </p>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Cash</dt>
              <dd className="tabular-nums">{formatMinor(totals.cashMinor, currency)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Investments</dt>
              <dd className="tabular-nums">{formatMinor(totals.investmentsMinor, currency)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Credit cards</dt>
              <dd className="tabular-nums">{formatMinor(totals.creditDebtMinor, currency)}</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Loans</dt>
              <dd className="tabular-nums">{formatMinor(totals.loanDebtMinor, currency)}</dd>
            </div>
          </dl>
        </Card>
      )}

      {month && month.budgets.length > 0 && (
        <Card title="Spending caps this month">
          <ul className="space-y-3">
            {month.budgets.map((b) => (
              <li key={b.id} className="space-y-1">
                <div className="flex justify-between gap-2 text-sm">
                  <span className="truncate">{b.categoryName}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatMinor(b.spentMinor, currency)} of{" "}
                    {formatMinor(b.availableMinor, currency)}
                  </span>
                </div>
                <Meter percent={b.percentUsed} over={b.overspent} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Next 7 days">
        {soon.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Nothing expected.</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {soon.map((e) => (
              <li key={e.id} className="flex justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">{e.merchant}</span>
                  <span className="text-slate-500 dark:text-slate-400">{dayLabel(e.date)}</span>
                </span>
                <span
                  className={`shrink-0 tabular-nums ${e.direction === "in" ? "text-green-700 dark:text-green-400" : ""}`}
                >
                  {e.direction === "in" ? "+" : "-"}
                  {formatMinor(Math.abs(e.amountMinor), currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
