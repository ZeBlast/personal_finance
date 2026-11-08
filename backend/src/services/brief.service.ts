import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts, type AccountSummary } from "./account.service.js";
import { summarize } from "./analytics.service.js";
import { cashForecast, type ForecastEvent } from "./forecast.service.js";
import { goalReservations } from "./goal.service.js";
import { getSettings, type Settings } from "./settings.service.js";

/**
 * The daily brief: how much is safe to spend until money next comes in, and where that number
 * comes from, so it can be checked line by line.
 *
 *   safe to spend = lowest projected cash before the next income
 *                   - what goals hold in those bank accounts
 *                   - the buffer the user wants to keep
 *
 * The projection is the cash forecast, so bills, expected and recurring items are already in it.
 * A card purchase reaches cash only through its card bill, so it is never subtracted twice.
 */

export interface BriefLine {
  label: string;
  date: string;
  /** Positive is money coming in, negative going out. */
  amountMinor: number;
  source: ForecastEvent["source"];
}

export interface DailyBrief {
  currency: string;
  today: string;
  /** Cash in the bank accounts now. */
  cashMinor: number;
  accountsCounted: number;
  /** The next money coming in, which ends the window, or null when none is expected in 60 days. */
  nextIncome: {
    date: string;
    label: string;
    amountMinor: number;
    key: string;
    /** True when it is the income the user picked rather than the next one. */
    chosen: boolean;
  } | null;
  /** Income the user can pick to count up to: the first of each coming in 60 days, by date. */
  incomeOptions: Array<{ key: string; date: string; label: string; amountMinor: number }>;
  /** The user picked an income that is not expected in the next 60 days. */
  incomeChoiceMissing: boolean;
  /** The last day counted: the day before the next income, or 30 days out without one. */
  until: string;
  /** What goes out before then, oldest first. */
  obligations: BriefLine[];
  obligationsMinor: number;
  /** The lowest the cash gets before then. */
  lowest: { date: string; balanceMinor: number };
  /** What goals hold in the bank accounts counted. */
  reservedMinor: number;
  reservedFor: Array<{ accountName: string; amountMinor: number }>;
  bufferMinor: number;
  /** What can be spent without the cash dropping below the buffer (never below zero). */
  safeToSpendMinor: number;
  /** Over by this much: the lowest point already falls short of the reserves and buffer. */
  shortMinor: number;
  /** Safe to spend shared over the days left, or null for a single day. */
  perDayMinor: number | null;
  /** Spent yesterday and so far this month (purchases; transfers left out). */
  spentYesterdayMinor: number;
  spentThisMonthMinor: number;
  /**
   * Connected bank accounts whose balance may be out of date (older than a day, or the connection
   * needs signing in again): the starting cash is only as good as these balances.
   */
  staleAccounts: Array<{ name: string; updatedAt: string | null; needsSignIn: boolean }>;
  /** Bank accounts left out because they have no balance yet. */
  missingAccounts: string[];
  /** Spending caps held back in the forecast, and how much of that falls before the window ends. */
  capHoldBack: { included: boolean; inWindowMinor: number };
}

/**
 * The bank accounts whose cash the brief counts: counted in totals, checking/savings/cash, in the
 * app's currency, with a balance, and hand-kept or in the active bank environment.
 */
export function briefCashAccounts(db: AppDb, settings: Settings): AccountSummary[] {
  return listAccounts(db).filter(
    (a) =>
      a.countsInTotals &&
      a.type === "depository" &&
      a.currency === settings.currency &&
      a.currentBalanceMinor !== null &&
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment),
  );
}

/** What goals hold in these accounts: money that is spoken for, not free to spend. */
export function goalMoneyInCash(
  db: AppDb,
  cashAccounts: AccountSummary[],
): { reservedMinor: number; reservedFor: Array<{ accountName: string; amountMinor: number }> } {
  const reserved = goalReservations(db);
  const reservedFor = cashAccounts
    .map((a) => ({ accountName: a.name, amountMinor: reserved.get(a.id) ?? 0 }))
    .filter((r) => r.amountMinor > 0);
  return { reservedFor, reservedMinor: reservedFor.reduce((n, r) => n + r.amountMinor, 0) };
}

/** A bank balance older than this may be out of date. */
const STALE_MS = 24 * 60 * 60 * 1000;

export function dailyBrief(
  db: AppDb,
  options: { today?: string | undefined; bufferMinor?: number | undefined } = {},
): DailyBrief {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const buffer = Math.max(0, options.bufferMinor ?? 0);
  const settings = getSettings(db);
  const forecast = cashForecast(db, { today, days: 60 });

  // The window runs to the day before the next money coming in, or the one the user picked.
  type Incoming = NonNullable<DailyBrief["nextIncome"]>;
  const incomes: Incoming[] = [];
  for (const d of forecast.days) {
    if (d.date <= today) continue;
    const incoming = d.events.filter(
      (e) => e.amountMinor > 0 && (e.source === "recurring" || e.source === "expected"),
    );
    for (const e of incoming) {
      const key = e.source === "recurring" ? `recurring:${e.seriesKey}` : `expected:${e.plannedId}`;
      incomes.push({
        date: d.date,
        label: e.label,
        amountMinor: e.amountMinor,
        key,
        chosen: false,
      });
    }
  }
  // The biggest on the first day with any money coming in.
  const firstDay = incomes[0]?.date;
  const first = incomes
    .filter((i) => i.date === firstDay)
    .reduce<Incoming | null>((a, b) => (a && a.amountMinor >= b.amountMinor ? a : b), null);
  const picked = settings.briefIncomeKey
    ? incomes.find((i) => i.key === settings.briefIncomeKey)
    : undefined;
  const incomeChoiceMissing = settings.briefIncomeKey !== null && !picked;
  const nextIncome: DailyBrief["nextIncome"] = picked ? { ...picked, chosen: true } : first;
  const seen = new Set<string>();
  const incomeOptions = incomes
    .filter((i) => !seen.has(i.key) && seen.add(i.key))
    .slice(0, 6)
    .map(({ key, date, label, amountMinor }) => ({ key, date, label, amountMinor }));
  const until = nextIncome ? addDays(nextIncome.date, -1) : addDays(today, 30);

  const inWindow = forecast.days.filter((d) => d.date <= until);
  const obligations: BriefLine[] = inWindow.flatMap((d) =>
    d.events
      .filter((e) => e.amountMinor < 0)
      .map((e) => ({
        label: e.card === undefined ? e.label : `${e.label} (${e.card} bill)`,
        date: d.date,
        amountMinor: e.amountMinor,
        source: e.source,
      })),
  );
  let lowest = { date: today, balanceMinor: forecast.startBalanceMinor };
  for (const d of inWindow) {
    if (d.balanceMinor < lowest.balanceMinor)
      lowest = { date: d.date, balanceMinor: d.balanceMinor };
  }

  // Goals' money in the bank accounts the forecast counts.
  const cashAccounts = briefCashAccounts(db, settings);
  // Balances are as old as the last sync, whatever day the brief is for.
  const dayAgo = new Date(Date.now() - STALE_MS).toISOString();
  const staleAccounts = cashAccounts
    .filter(
      (a) =>
        a.itemId !== null &&
        (a.connectionStatus !== "active" ||
          a.lastBalanceUpdateAt === null ||
          a.lastBalanceUpdateAt < dayAgo),
    )
    .map((a) => ({
      name: a.name,
      updatedAt: a.lastBalanceUpdateAt,
      needsSignIn: a.connectionStatus === "login_required",
    }));
  const missingAccounts = listAccounts(db)
    .filter(
      (a) =>
        a.countsInTotals &&
        a.type === "depository" &&
        a.currency === settings.currency &&
        a.currentBalanceMinor === null &&
        (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment),
    )
    .map((a) => a.name);
  const { reservedFor, reservedMinor } = goalMoneyInCash(db, cashAccounts);

  const free = lowest.balanceMinor - reservedMinor - buffer;
  const safe = Math.max(0, free);
  const daysLeft = inWindow.length;

  // What was spent: purchases only, as the reports count them.
  const spent = (from: string, to: string): number =>
    summarize(db, {
      from,
      to,
      groupBy: "category",
      includeTransfers: false,
      includePending: true,
      fill: false,
      environment: settings.plaidEnvironment,
    }).totals.spendingMinor;
  const yesterday = addDays(today, -1);

  return {
    currency: forecast.currency,
    today,
    cashMinor: forecast.startBalanceMinor,
    accountsCounted: forecast.accountsCounted,
    nextIncome,
    incomeOptions,
    incomeChoiceMissing,
    until,
    obligations,
    obligationsMinor: obligations.reduce((n, o) => n + o.amountMinor, 0),
    lowest,
    reservedMinor,
    reservedFor,
    bufferMinor: buffer,
    safeToSpendMinor: safe,
    shortMinor: free < 0 ? -free : 0,
    perDayMinor: daysLeft > 1 ? Math.floor(safe / daysLeft) : null,
    spentYesterdayMinor: spent(yesterday, yesterday),
    spentThisMonthMinor: spent(`${today.slice(0, 7)}-01`, today),
    staleAccounts,
    missingAccounts,
    capHoldBack: {
      included: forecast.capHoldBack.included,
      inWindowMinor: inWindow.reduce(
        (n, d) =>
          n +
          d.events
            .filter((e) => e.source === "cap_holdback")
            .reduce((m, e) => m - e.amountMinor, 0),
        0,
      ),
    },
  };
}
