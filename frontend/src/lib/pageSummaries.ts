import type { Account } from "../types/api";
import type { PeriodSummary } from "../types/calendar";
import type { MonthReport } from "../types/planning";
import type { Evaluation, Graph } from "./sandbox/graph";
import { nodeDef } from "./sandbox/graph";
import { isDebtAccount } from "./accountKinds";
import { formatMinor } from "./money";

/**
 * The one-sentence subtitles under page titles: what the page's own data says right now. Each is
 * pure, ends with a full stop, and says something plain when there is nothing to add up.
 */

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Accounts: what is in the bank and what is owed, from the accounts that count toward totals. */
export function accountsSentence(accounts: Account[]): string {
  const counted = accounts.filter((a) => a.countsInTotals && !a.hidden);
  if (counted.length === 0) return "No accounts yet.";
  // Totals in another currency would add up wrongly, so only the first account's currency counts.
  const currency = counted[0]!.currency;
  const same = counted.filter((a) => a.currency === currency);
  const bank = same.filter((a) => a.type === "depository" && a.currentBalanceMinor !== null);
  const debts = same.filter((a) => isDebtAccount(a) && (a.currentBalanceMinor ?? 0) > 0);
  const parts: string[] = [];
  if (bank.length > 0) {
    const inBank = bank.reduce((sum, a) => sum + (a.currentBalanceMinor ?? 0), 0);
    parts.push(`${formatMinor(inBank, currency)} in the bank`);
  }
  if (debts.length > 0) {
    const owed = debts.reduce((sum, a) => sum + (a.currentBalanceMinor ?? 0), 0);
    parts.push(
      `${formatMinor(owed, currency)} owed across ${plural(debts.length, "debt", "debts")}`,
    );
  }
  if (parts.length === 0) return `${plural(counted.length, "account", "accounts")} so far.`;
  return `${parts.join(", ")}.`;
}

/** The month's name for a sentence: "November", or "December 2025" when it is not in this year. */
export function monthTitle(month: string, today: string): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const name = new Date(year, mon - 1, 1).toLocaleDateString("en-US", { month: "long" });
  return month.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${year}`;
}

/** Calendar: the shown month's spending and where cash minus cards ends up. */
export function calendarSentence(s: PeriodSummary, monthName: string): string {
  if (s.spendingMinor === 0 && s.incomeMinor === 0 && s.expected.count === 0) {
    return `Nothing recorded or expected in ${monthName}.`;
  }
  const money = (minor: number) => formatMinor(minor, s.currency);
  const parts = [`${money(s.spendingMinor)} spent`];
  const end = s.balance.endMinor;
  if (end !== null) {
    const when = s.balance.projected ? " by month end" : "";
    parts.push(
      end >= 0
        ? `${money(end)} left after cards${when}`
        : `${money(-end)} short after cards${when}`,
    );
  }
  return `${monthName}: ${parts.join(", ")}.`;
}

/** Subscriptions: the ones you track and the recurring charges found in your history. */
export function subscriptionsSentence(input: {
  currency: string;
  tracked: { count: number; monthlyMinor: number };
  found: { count: number; monthlyMinor: number };
}): string {
  const money = (minor: number) => formatMinor(minor, input.currency);
  const parts: string[] = [];
  if (input.tracked.count > 0) {
    parts.push(
      `${plural(input.tracked.count, "subscription", "subscriptions")} tracked, ${money(input.tracked.monthlyMinor)} a month`,
    );
  }
  if (input.found.count > 0) {
    parts.push(
      `${plural(input.found.count, "recurring charge", "recurring charges")} found, ${money(input.found.monthlyMinor)} a month`,
    );
  }
  if (parts.length === 0) return "No subscriptions tracked and no recurring charges found yet.";
  return `${parts.join("; ")}.`;
}

/** Spending: the month so far, and where most of it went. */
export function spendingSentence(r: MonthReport, monthName: string): string {
  if (r.spendingMinor <= 0) return `Nothing spent in ${monthName} yet.`;
  const money = (minor: number) => formatMinor(minor, r.currency);
  const top = r.categories.reduce<MonthReport["categories"][number] | null>(
    (best, c) => (best === null || c.spendingMinor > best.spendingMinor ? c : best),
    null,
  );
  const tail = top && top.spendingMinor > 0 ? `, the most on ${top.label}` : "";
  return `${monthName} so far: ${money(r.spendingMinor)} spent${tail}.`;
}

/** Taxes: the year's estimate in one line. `money` takes dollars. */
export function taxesSentence(
  year: number,
  estimate: { grossIncome: number; total: number; effectiveRate: number },
  money: (dollars: number) => string,
): string {
  if (estimate.grossIncome <= 0) return `No income for ${year} yet, so no tax is estimated.`;
  const rate = `${(estimate.effectiveRate * 100).toFixed(1)}%`;
  return `About ${money(estimate.total)} in taxes on ${money(estimate.grossIncome)} of income in ${year}, ${rate} in all.`;
}

/** What-if: what each Result node in the current scenario shows. `money` takes dollars. */
export function scenarioSentence(
  graph: Graph,
  evaluation: Evaluation,
  money: (dollars: number) => string,
): string {
  const results = graph.nodes
    .filter((n) => n.kind === "result")
    .flatMap((n) => {
      const value = evaluation.inputs[n.id]?.["value"];
      return value !== undefined && Number.isFinite(value)
        ? [{ title: n.title ?? nodeDef(n.kind).label, value }]
        : [];
    });
  if (results.length === 0)
    return "Wire something into a Result to see what your scenario comes to.";
  return `${results
    .slice(0, 3)
    .map((r) => `${r.title}: ${money(r.value)} a year, ${money(r.value / 12)} a month`)
    .join("; ")}.`;
}
