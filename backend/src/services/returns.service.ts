import { and, asc, inArray } from "drizzle-orm";
import { balanceSnapshots, investmentTransactions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Investment returns: how the money did, apart from the money put in. A balance rises with every
 * contribution whether or not the market did, so the return takes the contributions out.
 *
 * Money-weighted, by the Modified Dietz method: the gain (end value, less start value, less what
 * was put in net of what was taken out) over the money that was invested on average, each
 * contribution counted for the share of the period it was in. It is close to the exact
 * money-weighted return (IRR) and stays sensible over short periods. Periods over a year are also
 * given as a yearly rate.
 *
 * Values come from the recorded and rebuilt balances (the same as "Value over time"); money in and
 * out from the contributions and withdrawals the bank, the TSP file or a CSV reported.
 */

export interface Flow {
  date: string;
  /** Positive is money put in, negative taken out. */
  amountMinor: number;
}

export interface ReturnResult {
  startDate: string;
  endDate: string;
  days: number;
  startValueMinor: number;
  endValueMinor: number;
  /** Put in less taken out during the period. */
  netContributedMinor: number;
  /** What the investments themselves made: the change in value less the net contributions. */
  gainMinor: number;
  /** As a fraction: 0.054 is 5.4%. Null when nothing was invested to measure against. */
  returnRate: number | null;
  /** For periods over a year: the same as a yearly rate. */
  annualRate: number | null;
}

const dayNumber = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** The Modified Dietz return over a period. Pure. */
export function modifiedDietz(
  startDate: string,
  endDate: string,
  startValueMinor: number,
  endValueMinor: number,
  flows: Flow[],
): ReturnResult {
  const days = Math.max(0, dayNumber(endDate) - dayNumber(startDate));
  const net = flows.reduce((n, f) => n + f.amountMinor, 0);
  const gain = endValueMinor - startValueMinor - net;
  // Each flow counts for the share of the period after it arrived.
  const weighted = flows.reduce((n, f) => {
    const share = days === 0 ? 0 : (dayNumber(endDate) - dayNumber(f.date)) / days;
    return n + f.amountMinor * Math.min(1, Math.max(0, share));
  }, 0);
  const invested = startValueMinor + weighted;
  const rate = invested > 0 ? gain / invested : null;
  return {
    startDate,
    endDate,
    days,
    startValueMinor,
    endValueMinor,
    netContributedMinor: net,
    gainMinor: gain,
    returnRate: rate,
    annualRate:
      rate !== null && days > 365 && rate > -1 ? Math.pow(1 + rate, 365 / days) - 1 : null,
  };
}

export interface AccountReturns {
  accountId: number;
  name: string;
  result: ReturnResult | null;
}

export interface ReturnPeriod {
  key: "ytd" | "year" | "all";
  label: string;
  from: string;
  to: string;
  combined: ReturnResult | null;
  accounts: AccountReturns[];
}

export interface PortfolioReturns {
  periods: ReturnPeriod[];
  /** Accounts left out: no value recorded before today, so no growth to measure yet. */
  withoutHistory: string[];
}

interface AccountData {
  id: number;
  name: string;
  /** The last value of each day with one, oldest first. */
  values: Array<{ date: string; valueMinor: number }>;
  flows: Flow[];
}

/** The value on a day: the last one on or before it, or null before the first. Pure. */
function valueOn(values: AccountData["values"], day: string): number | null {
  let found: number | null = null;
  for (const v of values) {
    if (v.date > day) break;
    found = v.valueMinor;
  }
  return found;
}

/**
 * One account's (or several together) return over a period. An account whose history starts
 * inside the period is counted from its first value, which enters as money put in on that day.
 * Pure.
 */
export function periodReturn(
  accounts: AccountData[],
  from: string,
  to: string,
): ReturnResult | null {
  let start = 0;
  let end = 0;
  const flows: Flow[] = [];
  let any = false;
  for (const a of accounts) {
    if (a.values.length === 0) continue;
    const first = a.values[0]!.date;
    // Nothing to measure before the last day: its value cannot show growth yet.
    if (first >= to) continue;
    any = true;
    const atStart = valueOn(a.values, from);
    const begins = atStart === null ? first : from;
    if (atStart === null) flows.push({ date: first, amountMinor: a.values[0]!.valueMinor });
    else start += atStart;
    end += valueOn(a.values, to) ?? 0;
    for (const f of a.flows) if (f.date > begins && f.date <= to) flows.push(f);
  }
  if (!any) return null;
  return modifiedDietz(from, to, start, end, flows);
}

function loadAccounts(db: AppDb): AccountData[] {
  const environment = getSettings(db).plaidEnvironment;
  const list = listAccounts(db).filter(
    (a) =>
      a.type === "investment" && (a.itemId === null || a.connectionEnvironment === environment),
  );
  const ids = list.map((a) => a.id);
  if (ids.length === 0) return [];
  const values = new Map<number, Map<string, number>>();
  for (const s of db
    .select({
      accountId: balanceSnapshots.accountId,
      observedAt: balanceSnapshots.observedAt,
      value: balanceSnapshots.currentBalanceMinor,
    })
    .from(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, ids))
    .orderBy(asc(balanceSnapshots.observedAt), asc(balanceSnapshots.id))
    .all()) {
    if (s.value === null) continue;
    const days = values.get(s.accountId) ?? new Map<string, number>();
    days.set(s.observedAt.slice(0, 10), s.value);
    values.set(s.accountId, days);
  }
  const flows = new Map<number, Flow[]>();
  for (const t of db
    .select({
      accountId: investmentTransactions.accountId,
      date: investmentTransactions.date,
      amountMinor: investmentTransactions.amountMinor,
    })
    .from(investmentTransactions)
    .where(
      and(
        inArray(investmentTransactions.accountId, ids),
        inArray(investmentTransactions.type, ["contribution", "withdrawal"]),
      ),
    )
    .all()) {
    // Stored with money coming in negative.
    const list = flows.get(t.accountId) ?? [];
    list.push({ date: t.date, amountMinor: -t.amountMinor });
    flows.set(t.accountId, list);
  }
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    values: [...(values.get(a.id) ?? new Map()).entries()]
      .map(([date, valueMinor]) => ({ date, valueMinor }))
      .sort((x, y) => (x.date < y.date ? -1 : 1)),
    flows: flows.get(a.id) ?? [],
  }));
}

export function portfolioReturns(
  db: AppDb,
  today = new Date().toISOString().slice(0, 10),
): PortfolioReturns {
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const accounts = loadAccounts(db);
  // An account needs a value before today to show any growth.
  const withHistory = accounts.filter((a) => a.values.length > 0 && a.values[0]!.date < today);
  const firstDay = withHistory.map((a) => a.values[0]!.date).sort()[0] ?? today;
  const specs: Array<Pick<ReturnPeriod, "key" | "label" | "from">> = [
    { key: "ytd", label: "This year", from: `${today.slice(0, 4)}-01-01` },
    { key: "year", label: "Last 12 months", from: addDays(today, -365) },
    { key: "all", label: "Since records began", from: firstDay },
  ];
  return {
    periods: specs.map((p) => {
      const from = p.from < firstDay ? firstDay : p.from;
      return {
        ...p,
        from,
        to: today,
        combined: periodReturn(withHistory, from, today),
        accounts: withHistory.map((a) => ({
          accountId: a.id,
          name: a.name,
          result: periodReturn([a], from, today),
        })),
      };
    }),
    withoutHistory: accounts.filter((a) => !withHistory.includes(a)).map((a) => a.name),
  };
}
