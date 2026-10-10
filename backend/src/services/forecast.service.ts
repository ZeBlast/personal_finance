import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { listBills } from "./bills.service.js";
import { listOccurrences } from "./calendar.service.js";
import { nextAfter, recurringReport } from "./recurring.service.js";
import { getSettings } from "./settings.service.js";

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
  source: "expected" | "recurring" | "card_bill";
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
    (a) => a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment,
  );
  const cash = all.filter(
    (a) =>
      a.type === "depository" && a.currency === settings.currency && a.currentBalanceMinor !== null,
  );
  const typeByName = new Map(all.map((a) => [a.name, a.type]));
  const start = cash.reduce((n, a) => n + a.currentBalanceMinor!, 0);

  const events = new Map<string, ForecastEvent[]>();
  const add = (date: string, e: ForecastEvent): void => {
    if (date <= today || date > end || e.amountMinor === 0) return;
    events.set(date, [...(events.get(date) ?? []), e]);
  };

  // 1. What the user expects.
  const planned = listOccurrences(db, addDays(today, 1), end).filter(
    (o) => o.status === "expected" && (o.accountType === null || o.accountType === "depository"),
  );
  for (const o of planned) {
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
      add(d, {
        label: s.merchant,
        amountMinor: s.direction === "in" ? amount : -amount,
        source: "recurring",
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
    });
    if (bill.next) {
      add(bill.next.dueOn, {
        label: `${bill.name} bill (so far)`,
        amountMinor: -bill.next.balanceSoFarMinor,
        source: "card_bill",
      });
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
