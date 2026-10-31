import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { summarize } from "./analytics.service.js";
import { cashForecast, type ForecastEvent } from "./forecast.service.js";
import { goalReservations } from "./goal.service.js";
import { getSettings } from "./settings.service.js";

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
  nextIncome: { date: string; label: string; amountMinor: number } | null;
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
}

/** A bank balance older than this may be out of date. */
const STALE_MS = 24 * 60 * 60 * 1000;

export function dailyBrief(
  db: AppDb,
  options: {
    today?: string | undefined;
    bufferMinor?: number | undefined;
    includeGoals?: boolean | undefined;
    includeBudget?: boolean | undefined;
  } = {},
): DailyBrief {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const buffer = Math.max(0, options.bufferMinor ?? 0);
  const settings = getSettings(db);
  const forecast = cashForecast(db, {
    today,
    days: 60,
    includeGoals: options.includeGoals,
    includeBudget: options.includeBudget,
  });

  // The window runs to the day before the next money coming in.
  let nextIncome: DailyBrief["nextIncome"] = null;
  for (const d of forecast.days) {
    const incoming = d.events.filter(
      (e) => e.amountMinor > 0 && (e.source === "recurring" || e.source === "expected"),
    );
    if (d.date > today && incoming.length > 0) {
      const biggest = incoming.reduce((a, b) => (b.amountMinor > a.amountMinor ? b : a));
      nextIncome = { date: d.date, label: biggest.label, amountMinor: biggest.amountMinor };
      break;
    }
  }
  const until = nextIncome ? addDays(nextIncome.date, -1) : addDays(today, 30);

  const inWindow = forecast.days.filter((d) => d.date <= until);
  const obligations: BriefLine[] = inWindow.flatMap((d) =>
    d.events
      .filter((e) => e.amountMinor < 0)
      .map((e) => ({ label: e.label, date: d.date, amountMinor: e.amountMinor, source: e.source })),
  );
  let lowest = { date: today, balanceMinor: forecast.startBalanceMinor };
  for (const d of inWindow) {
    if (d.balanceMinor < lowest.balanceMinor)
      lowest = { date: d.date, balanceMinor: d.balanceMinor };
  }

  // Goals' money in the bank accounts the forecast counts.
  const reserved = goalReservations(db);
  const cashAccounts = listAccounts(db).filter(
    (a) =>
      a.countsInTotals &&
      a.type === "depository" &&
      a.currency === settings.currency &&
      a.currentBalanceMinor !== null &&
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment),
  );
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
  const reservedFor = cashAccounts
    .map((a) => ({ accountName: a.name, amountMinor: reserved.get(a.id) ?? 0 }))
    .filter((r) => r.amountMinor > 0);
  const reservedMinor = reservedFor.reduce((n, r) => n + r.amountMinor, 0);

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
  };
}
