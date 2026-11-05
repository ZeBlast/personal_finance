import { eq } from "drizzle-orm";
import { categories, subscriptionReviews, trackedSubscriptions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, addMonths, isRealDate } from "../utils/dates.js";
import { budgetMonth } from "./budget.service.js";
import { capHoldBack } from "./cap-holdback.js";
import { debtOverview } from "./debt.service.js";
import { listGoals, type GoalDto } from "./goal.service.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { closingDates, dueAfter, listBills, type CardBill } from "./bills.service.js";
import { listOccurrences } from "./calendar.service.js";
import { accountYieldsById, monthlyInterest } from "./interest.service.js";
import { nextAfter, recurringReport, type Cadence } from "./recurring.service.js";
import { getSettings } from "./settings.service.js";
import { pendingManualTransactions, matchesPendingManual } from "./pending-manual.service.js";
import type { ScenarioAdjustment } from "./scenario.service.js";

/**
 * A forecast of the cash in the user's bank accounts (checking, savings, cash) day by day: today's
 * balances, plus what is expected to come in and go out.
 *
 * What it counts:
 * - Expected transactions the user entered (the calendar's, which include the subscriptions they
 *   added), when they are on a bank account or on no account in particular.
 * - Recurring charges and deposits found in the history (paychecks, rent, bills, subscriptions),
 *   continued on their schedule. One the user marked cancelled, as a subscription or in the
 *   subscription review, is left out. A recurring item with the same merchant as an expected
 *   transaction is counted once.
 * - Credit card bills, for cards whose statement dates are set: what is left of the latest statement
 *   on its due day, and the next statement (as charged so far) on the following due day.
 * - Expected and recurring charges to such a card: on the due day of the bill they will be on, since
 *   that is when they leave the bank account. A card without statement dates has no bills here, so
 *   its charges are left out.
 * - The debt payoff plan's extra monthly payment, when the user chose to count it.
 * - Interest on bank accounts whose APY the user entered: on the last day of each month, on the
 *   account's balance today plus the interest before it. Interest found recurring in such an
 *   account's history is left to this, so it is not counted twice.
 * - Goals whose monthly contribution the user chose to count: that amount on the chosen day of each
 *   month, until the goal is met. It lowers the line even when the money stays in a savings account
 *   that is counted, since money set aside is no longer free to spend.
 * - When the user chose to, what is left of this month's spending caps, less what is already
 *   forecast in their categories, spread over the days left in the month.
 *
 * A what-if scenario's adjustments are applied on top of all of this, to the forecast's own copy of
 * the inputs: a one-off or recurring amount is added, a recurring or expected series is stopped or
 * changed from a day, and a goal's contribution is swapped for another.
 *
 * It is an estimate, and says what each day's change is made of so the user can judge it.
 */

export const MAX_FORECAST_DAYS = 180;

export interface ForecastEvent {
  label: string;
  /** Positive is money coming in, negative going out. */
  amountMinor: number;
  source:
    | "expected"
    | "recurring"
    | "card_bill"
    | "pending"
    | "debt_plan"
    | "interest"
    | "goal"
    | "cap_holdback"
    | "scenario";
  /** A detected recurring series: its key (to dismiss it) and schedule (to plan it). */
  seriesKey?: string;
  cadence?: Cadence;
  /** A card bill, or a charge paid with one: the card. Interest: the bank account. */
  accountId?: number;
  /** A goal contribution: the goal. */
  goalId?: number;
  /** An expected or recurring charge: its category (what a spending cap counts), and for an expected one, its plan. */
  categoryId?: number;
  plannedId?: number;
  /** A charge paid with a card bill: the card's name, and the day it is charged to the card. */
  card?: string;
  chargedOn?: string;
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
  /** The rest of this month's spending caps held back (when asked for), and which caps. */
  capHoldBack: {
    included: boolean;
    totalMinor: number;
    caps: Array<{ categoryName: string; heldMinor: number; alreadyForecastMinor: number }>;
  };
}

const MONTH_NAME = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const norm = (s: string): string => s.trim().toLowerCase();

/** The last day of a `YYYY-MM` month. Pure. */
function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/**
 * Recurring series the user said are cancelled, with the day their charges stop: a tracked
 * subscription marked cancelled (from its day), or one marked cancelled in the subscription review
 * (from when it was marked).
 */
function cancelledSeries(db: AppDb): Map<string, string> {
  const stops = new Map<string, string>();
  const reviewed = db
    .select({ key: subscriptionReviews.key, on: subscriptionReviews.updatedAt })
    .from(subscriptionReviews)
    .where(eq(subscriptionReviews.status, "cancelled"))
    .all();
  for (const r of reviewed) stops.set(r.key, r.on.slice(0, 10));
  const tracked = db
    .select({ key: trackedSubscriptions.recurringKey, on: trackedSubscriptions.cancelledOn })
    .from(trackedSubscriptions)
    .where(eq(trackedSubscriptions.status, "cancelled"))
    .all();
  for (const r of tracked) {
    if (r.key === null || r.on === null) continue;
    const earlier = stops.get(r.key);
    stops.set(r.key, earlier !== undefined && earlier < r.on ? earlier : r.on);
  }
  return stops;
}

/**
 * The contributions to goals that count in the forecast: each month on the goal's day, until what
 * is left of the goal is covered (the last one is the remainder). Pure.
 */
export function goalEvents(
  goals: Array<Pick<GoalDto, "id" | "name" | "remainingMinor" | "reached" | "forecast">>,
  today: string,
  end: string,
): Array<{ date: string; event: ForecastEvent }> {
  const out: Array<{ date: string; event: ForecastEvent }> = [];
  for (const g of goals) {
    if (g.reached || g.forecast === null) continue;
    let left = g.remainingMinor;
    for (let k = 0; left > 0; k += 1) {
      const date = `${addMonths(today.slice(0, 7), k)}-${String(g.forecast.day).padStart(2, "0")}`;
      if (date > end) break;
      if (date <= today) continue;
      const amount = Math.min(g.forecast.monthlyMinor, left);
      left -= amount;
      out.push({
        date,
        event: {
          label: `Set aside for ${g.name}`,
          amountMinor: -amount,
          source: "goal",
          goalId: g.id,
        },
      });
    }
  }
  return out;
}

export function cashForecast(
  db: AppDb,
  options: {
    days?: number | undefined;
    today?: string | undefined;
    /** Overrides the setting that holds back the rest of the month's caps. */
    holdCaps?: boolean | undefined;
    /** What-if changes laid over the forecast. Nothing is stored. */
    adjustments?: ScenarioAdjustment[] | undefined;
    /** Filled with the indexes of the adjustments that found their series, plan or goal here. */
    matched?: Set<number> | undefined;
  } = {},
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

  const adjustments = options.adjustments ?? [];
  // A series changed or stopped by the scenario: the event as it should be, or null when it stops.
  // `date` is the day the charge is made (for a card, not the day its bill is paid).
  const hits = (a: ScenarioAdjustment, ref: { seriesKey?: string; plannedId?: number }): boolean =>
    a.kind === "change_series" &&
    (("seriesKey" in a.target && a.target.seriesKey === ref.seriesKey) ||
      ("plannedId" in a.target && a.target.plannedId === ref.plannedId));
  /** Notes which adjustments point at this series or plan, even when none of its days are changed. */
  const markMatches = (ref: { seriesKey?: string; plannedId?: number }): void => {
    adjustments.forEach((a, i) => {
      if (hits(a, ref)) options.matched?.add(i);
    });
  };
  const adjustSeries = (
    e: ForecastEvent,
    date: string,
    ref: { seriesKey?: string; plannedId?: number },
  ): ForecastEvent | null => {
    let out: ForecastEvent | null = e;
    for (const a of adjustments) {
      if (a.kind !== "change_series" || date < a.fromDate) continue;
      if (!hits(a, ref) || out === null) continue;
      out =
        a.amountMinor === null
          ? null
          : { ...out, amountMinor: Math.sign(out.amountMinor) * a.amountMinor };
    }
    return out;
  };

  const events = new Map<string, ForecastEvent[]>();
  const allPending = pendingManualTransactions(db, { to: end, currency: settings.currency });
  const pending = allPending.filter((t) => t.accountType === "depository");
  // An overdue pending entry is still outstanding: project it on the first future day.
  const pendingDate = (date: string): string => (date > today ? date : addDays(today, 1));
  const projectedPending = pending.map((t) => ({ ...t, date: pendingDate(t.date) }));
  // Spending in a category (what a spending cap counts), by the day the charge is made, even when a
  // card charge's bill is paid after the forecast ends. Goal and interest events have no category.
  const spending: Array<{ date: string; categoryId: number; amountMinor: number }> = [];
  const add = (date: string, e: ForecastEvent): void => {
    const madeOn = e.chargedOn ?? date;
    if (e.categoryId !== undefined && e.amountMinor < 0 && madeOn > today && madeOn <= end) {
      spending.push({ date: madeOn, categoryId: e.categoryId, amountMinor: -e.amountMinor });
    }
    if (date <= today || date > end || e.amountMinor === 0) return;
    events.set(date, [...(events.get(date) ?? []), e]);
  };
  for (const t of pending) {
    add(pendingDate(t.date), { label: t.merchant, amountMinor: -t.amountMinor, source: "pending" });
  }

  // Cards with a known bill: a charge to one leaves the bank on the due day of the bill it is on.
  const bills = listBills(db, today).filter(
    (b) => b.statement !== null && b.currency === settings.currency,
  );
  const billByAccount = new Map(bills.map((b) => [b.accountId, b]));
  const billByName = new Map(bills.map((b) => [b.name, b]));
  const billDueFor = (bill: CardBill, date: string): string => {
    const closes = closingDates(bill.settings!.closingDay, date);
    return dueAfter(closes.last === date ? closes.last : closes.next, bill.settings!.dueDay);
  };
  const addCharge = (bill: CardBill, date: string, e: ForecastEvent): void => {
    add(billDueFor(bill, date), {
      ...e,
      accountId: bill.accountId,
      card: bill.name,
      chargedOn: date,
    });
  };

  // 1. What the user expects.
  const planned = listOccurrences(db, addDays(today, 1), end).filter(
    (o) => o.status === "expected",
  );
  const plannedMerchants = new Set<string>();
  for (const o of planned) {
    const amount = Math.abs(o.amountMinor);
    const event: ForecastEvent = {
      label: o.merchant,
      amountMinor: o.direction === "in" ? amount : -amount,
      source: "expected",
      plannedId: o.plannedId,
      ...(o.categoryId !== null ? { categoryId: o.categoryId } : {}),
    };
    markMatches({ plannedId: o.plannedId });
    const changed = adjustSeries(event, o.date, { plannedId: o.plannedId });
    if (o.accountType === null || o.accountType === "depository") {
      if (matchesPendingManual(projectedPending, o)) continue;
      if (changed) add(o.date, changed);
    } else {
      const bill = o.accountId === null ? undefined : billByAccount.get(o.accountId);
      if (!bill || matchesPendingManual(allPending, o)) continue;
      if (changed) addCharge(bill, o.date, changed);
    }
    plannedMerchants.add(norm(o.merchant));
  }

  // 2. Recurring money in and out, until the day the user said it was cancelled.
  const stops = cancelledSeries(db);
  const apys = accountYieldsById(db);
  const earning = cash.filter((a) => (apys.get(a.id) ?? 0) > 0);
  const earningNames = new Set(earning.map((a) => a.name));
  for (const s of recurringReport(db, { today }).series) {
    if (s.status !== "active" || s.dismissed || plannedMerchants.has(norm(s.merchant))) continue;
    // Interest paid into an account with an APY: step 5 estimates it.
    const interest = s.direction === "in" && /interest/i.test(s.merchant);
    if (interest && s.accountNames.some((name) => earningNames.has(name))) continue;
    const onBank = s.accountNames.some((name) => typeByName.get(name) === "depository");
    const bill = onBank
      ? undefined
      : s.accountNames.map((name) => billByName.get(name)).find((b) => b !== undefined);
    if (!onBank && !bill) continue;
    markMatches({ seriesKey: s.key });
    const stop = stops.get(s.key);
    const amount = s.typicalAmountMinor;
    for (let d = s.nextExpected, guard = 0; d <= end && guard < 400; d = nextAfter(d, s.cadence)) {
      guard += 1;
      if (stop !== undefined && d >= stop) break;
      if (d <= today) continue;
      if (
        matchesPendingManual(bill ? allPending : projectedPending, {
          date: d,
          merchant: s.merchant,
          amountMinor: amount,
          direction: s.direction,
          accountId: bill?.accountId ?? null,
        })
      )
        continue;
      const event: ForecastEvent = {
        label: s.merchant,
        amountMinor: s.direction === "in" ? amount : -amount,
        source: "recurring",
        seriesKey: s.key,
        cadence: s.cadence,
        ...(s.categoryId !== null ? { categoryId: s.categoryId } : {}),
      };
      const changed = adjustSeries(event, d, { seriesKey: s.key });
      if (!changed) continue;
      if (bill) addCharge(bill, d, changed);
      else add(d, changed);
    }
  }

  // 3. Card bills.
  for (const bill of bills) {
    if (!bill.statement) continue;
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
        add(billDueFor(bill, t.date), {
          label: `${bill.name} pending charges`,
          amountMinor: -t.amountMinor,
          source: "pending",
        });
      }
    }
  }

  // 4. The debt plan's extra payment, when the user counts it: on the 1st of each month, until the
  // plan has the debts paid off.
  const extra = settings.debtExtraInForecastMinor;
  if (extra > 0) {
    const months = debtOverview(db, { extraMinor: extra }).plan.months ?? Infinity;
    for (let k = 1; k <= months; k += 1) {
      const day = `${addMonths(today.slice(0, 7), k)}-01`;
      if (day > end) break;
      add(day, { label: "Extra debt payment (plan)", amountMinor: -extra, source: "debt_plan" });
    }
  }

  // 5. Interest, at the end of each month.
  const monthEnds: string[] = [];
  for (let k = 0; ; k += 1) {
    const day = lastDayOf(addMonths(today.slice(0, 7), k));
    if (day > end) break;
    if (day > today) monthEnds.push(day);
  }
  for (const a of earning) {
    const paid = monthlyInterest(a.currentBalanceMinor!, apys.get(a.id)!, monthEnds.length);
    monthEnds.forEach((day, k) => {
      add(day, {
        label: `${a.name} interest`,
        amountMinor: paid[k]!,
        source: "interest",
        accountId: a.id,
      });
    });
  }

  // 6. Money set aside for goals.
  const goals = listGoals(db, today).map((g) => {
    let forecast = g.forecast;
    adjustments.forEach((a, i) => {
      if (a.kind !== "goal" || a.goalId !== g.id) return;
      forecast = a.forecast;
      options.matched?.add(i);
    });
    return { ...g, forecast };
  });
  for (const { date, event } of goalEvents(goals, today, end)) add(date, event);

  // 6b. The scenario's own one-off and recurring amounts.
  for (const a of adjustments) {
    if (a.kind === "one_off") {
      add(a.date, { label: a.label, amountMinor: a.amountMinor, source: "scenario" });
    } else if (a.kind === "recurring") {
      // Skip ahead past today first, so an old start date still continues on its schedule.
      let first = a.startDate;
      while (first <= today) first = nextAfter(first, a.cadence);
      for (let d = first; d <= end; d = nextAfter(d, a.cadence)) {
        if (a.endDate !== null && d > a.endDate) break;
        add(d, {
          label: a.label,
          amountMinor: a.amountMinor,
          source: "scenario",
          cadence: a.cadence,
        });
      }
    }
  }

  // 7. The rest of this month's spending caps, less what the steps above already forecast in them
  // (goal and interest events carry no category, so they never count as spending).
  const hold = options.holdCaps ?? settings.forecastHoldCaps;
  let capHold: Forecast["capHoldBack"] = { included: false, totalMinor: 0, caps: [] };
  if (hold) {
    const month = today.slice(0, 7);
    const parentOf = new Map(
      db
        .select({ id: categories.id, parentId: categories.parentId })
        .from(categories)
        .all()
        .map((c) => [c.id, c.parentId] as const),
    );
    const r = capHoldBack({
      today,
      caps: budgetMonth(db, month, settings.plaidEnvironment, { today }).budgets,
      parentOf,
      forecastOut: spending,
      through: end,
    });
    const label = `Spending caps (rest of ${MONTH_NAME[Number(month.slice(5)) - 1]})`;
    for (const d of r.days) {
      add(d.date, { label, amountMinor: -d.amountMinor, source: "cap_holdback" });
    }
    capHold = { included: true, totalMinor: r.totalMinor, caps: r.caps };
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
    capHoldBack: capHold,
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
