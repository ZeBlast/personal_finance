import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { closingDates, dueAfter, listBills } from "./bills.service.js";
import { listOccurrences } from "./calendar.service.js";
import { nextAfter, recurringReport, type Cadence } from "./recurring.service.js";
import { getSettings } from "./settings.service.js";
import { pendingManualTransactions, matchesPendingManual } from "./pending-manual.service.js";

/**
 * A forecast of the cash in the user's bank accounts (checking, savings, cash) day by day: today's
 * balances, plus what is expected to come in and go out.
 *
 * What it counts:
 * - Expected transactions the user entered (the calendar's), when they are on a bank account or on
 *   no account in particular.
 * - Recurring charges and deposits found in the bank accounts' history (paychecks, rent, bills),
 *   continued on their schedule. Ones charged to a credit card are left out: they reach the bank
 *   account only when the card is paid, which the next item covers. A recurring item with the same
 *   merchant as an expected transaction is counted once.
 * - Credit card bills, for cards whose statement dates are set: what is left of the latest statement
 *   on its due day, and the next statement (as charged so far) on the following due day.
 *
 * It is an estimate, and says what each day's change is made of so the user can judge it.
 */

export const MAX_FORECAST_DAYS = 180;

export interface ForecastEvent {
  label: string;
  /** Positive is money coming in, negative going out. */
  amountMinor: number;
  source: "expected" | "recurring" | "card_bill" | "pending";
  /** A detected recurring series: its key (to dismiss it) and schedule (to plan it). */
  seriesKey?: string;
  cadence?: Cadence;
  /** A card bill: the card. */
  accountId?: number;
}

export interface ForecastDay {
  date: string;
  balanceMinor: number;
  changeMinor: number;
  events: ForecastEvent[];
}

export interface Forecast {
  currency: string;
  today: string;
  startBalanceMinor: number;
  accountsCounted: number;
  days: ForecastDay[];
  lowest: { date: string; balanceMinor: number };
  endBalanceMinor: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

export function cashForecast(
  db: AppDb,
  options: { days?: number | undefined; today?: string | undefined } = {},
): Forecast {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) throw new AppError(400, "invalid_date", "Use a real day.");
  const span = Math.min(Math.max(options.days ?? 60, 7), MAX_FORECAST_DAYS);
  const end = addDays(today, span);
  const settings = getSettings(db);

  const all = listAccounts(db).filter(
    (a) =>
      a.countsInTotals &&
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment),
  );
  const cash = all.filter(
    (a) =>
      a.type === "depository" && a.currency === settings.currency && a.currentBalanceMinor !== null,
  );
  const typeByName = new Map(all.map((a) => [a.name, a.type]));
  const start = cash.reduce((n, a) => n + a.currentBalanceMinor!, 0);

  const events = new Map<string, ForecastEvent[]>();
  const allPending = pendingManualTransactions(db, { to: end, currency: settings.currency });
  const pending = allPending.filter((t) => t.accountType === "depository");
  // An overdue pending entry is still outstanding: project it on the first future day.
  const pendingDate = (date: string): string => (date > today ? date : addDays(today, 1));
  const projectedPending = pending.map((t) => ({ ...t, date: pendingDate(t.date) }));
  const add = (date: string, e: ForecastEvent): void => {
    if (date <= today || date > end || e.amountMinor === 0) return;
    events.set(date, [...(events.get(date) ?? []), e]);
  };
  for (const t of pending) {
    add(pendingDate(t.date), { label: t.merchant, amountMinor: -t.amountMinor, source: "pending" });
  }

  // 1. What the user expects.
  const planned = listOccurrences(db, addDays(today, 1), end).filter(
    (o) => o.status === "expected" && (o.accountType === null || o.accountType === "depository"),
  );
  for (const o of planned) {
    if (matchesPendingManual(projectedPending, o)) continue;
    const amount = Math.abs(o.amountMinor);
    add(o.date, {
      label: o.merchant,
      amountMinor: o.direction === "in" ? amount : -amount,
      source: "expected",
    });
  }
  const plannedMerchants = new Set(planned.map((o) => norm(o.merchant)));

  // 2. Recurring money in and out of the bank accounts.
  for (const s of recurringReport(db, { today }).series) {
    if (s.status !== "active" || s.dismissed || plannedMerchants.has(norm(s.merchant))) continue;
    if (!s.accountNames.some((name) => typeByName.get(name) === "depository")) continue;
    const amount = s.typicalAmountMinor;
    for (let d = s.nextExpected, guard = 0; d <= end && guard < 400; d = nextAfter(d, s.cadence)) {
      guard += 1;
      if (
        matchesPendingManual(projectedPending, {
          date: d,
          merchant: s.merchant,
          amountMinor: amount,
          direction: s.direction,
          accountId: null,
        })
      )
        continue;
      add(d, {
        label: s.merchant,
        amountMinor: s.direction === "in" ? amount : -amount,
        source: "recurring",
        seriesKey: s.key,
        cadence: s.cadence,
      });
    }
  }

  // 3. Card bills.
  for (const bill of listBills(db, today)) {
    if (!bill.statement || bill.currency !== settings.currency) continue;
    add(bill.statement.dueOn, {
      label: `${bill.name} bill`,
      amountMinor: -bill.statement.remainingMinor,
      source: "card_bill",
      accountId: bill.accountId,
    });
    if (bill.next) {
      add(bill.next.dueOn, {
        label: `${bill.name} bill (so far)`,
        amountMinor: -bill.next.balanceSoFarMinor,
        source: "card_bill",
        accountId: bill.accountId,
      });
      // Pending card entries beyond the next closing date belong to a later bill. Charge cash
      // on that bill's due date rather than on the purchase date, and do not count them twice.
      for (const t of allPending.filter(
        (t) => t.accountId === bill.accountId && t.date > bill.next!.closesOn,
      )) {
        const closes = closingDates(bill.settings!.closingDay, t.date);
        const closedOn = closes.last === t.date ? closes.last : closes.next;
        add(dueAfter(closedOn, bill.settings!.dueDay), {
          label: `${bill.name} pending charges`,
          amountMinor: -t.amountMinor,
          source: "pending",
        });
      }
    }
  }

  const days: ForecastDay[] = [];
  let balance = start;
  let lowest = { date: today, balanceMinor: start };
  for (let d = today; d <= end; d = addDays(d, 1)) {
    const todays = events.get(d) ?? [];
    const change = todays.reduce((n, e) => n + e.amountMinor, 0);
    balance += change;
    days.push({ date: d, balanceMinor: balance, changeMinor: change, events: todays });
    if (balance < lowest.balanceMinor) lowest = { date: d, balanceMinor: balance };
  }
  return {
    currency: settings.currency,
    today,
    startBalanceMinor: start,
    accountsCounted: cash.length,
    days,
    lowest,
    endBalanceMinor: balance,
  };
}

/**
 * The cash forecast for the days of a calendar span that lie ahead (up to the forecast's reach):
 * each day's projected cash in the bank accounts and what changes it. Days before tomorrow and
 * past the reach are left out, so the calendar shows no forecast for them.
 */
export function calendarForecast(
  db: AppDb,
  from: string,
  to: string,
  today: string = new Date().toISOString().slice(0, 10),
): {
  currency: string;
  today: string;
  accountsCounted: number;
  /** The last day the forecast reaches. */
  reach: string;
  days: Array<{ date: string; cashMinor: number; events: ForecastEvent[] }>;
} {
  if (!isRealDate(from) || !isRealDate(to) || to < from) {
    throw new AppError(400, "invalid_range", "Choose a real span of days.");
  }
  const reach = addDays(today, MAX_FORECAST_DAYS);
  if (to <= today || from > reach) {
    const settings = getSettings(db);
    return { currency: settings.currency, today, accountsCounted: 0, reach, days: [] };
  }
  const days = Math.max(7, Math.round((Date.parse(to) - Date.parse(today)) / 86_400_000));
  const f = cashForecast(db, { today, days: Math.min(days, MAX_FORECAST_DAYS) });
  return {
    currency: f.currency,
    today,
    accountsCounted: f.accountsCounted,
    reach,
    days: f.days
      .filter((d) => d.date > today && d.date >= from && d.date <= to)
      .map((d) => ({ date: d.date, cashMinor: d.balanceMinor, events: d.events })),
  };
}
