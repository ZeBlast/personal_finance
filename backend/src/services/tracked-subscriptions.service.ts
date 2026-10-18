import { eq, sql } from "drizzle-orm";
import { accounts, categories, trackedSubscriptions } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { createPlanned, deletePlanned, type PlannedInput } from "./calendar.service.js";

/**
 * Subscriptions the user keeps track of (see the tracked_subscriptions table): what each costs,
 * how it is billed, when it next charges or ends, and details about the account with the service
 * (the email used, a username, the website, notes).
 *
 * One the user adds by hand also gets a planned transaction for its upcoming charges, so they show
 * on the calendar and in the cash forecast. One found in the history does not: the forecast already
 * expects it from the history, and a second copy would count it twice.
 */

export const BILLINGS = ["recurring", "installments", "prepaid"] as const;
export type Billing = (typeof BILLINGS)[number];
export const SUB_FREQUENCIES = ["weekly", "monthly", "yearly"] as const;
export type SubFrequency = (typeof SUB_FREQUENCIES)[number];

const MAX_AMOUNT = 100_000_000; // $1,000,000
const MAX_TERM_MONTHS = 120;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `day` plus `months` months; the 31st becomes the last day of a shorter month. Pure. */
export function addMonthsToDay(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    Math.min(d, last),
  ).padStart(2, "0")}`;
}

/** The fields that decide when a subscription charges. */
export interface ScheduleInput {
  amountMinor: number;
  billing: Billing;
  frequency: SubFrequency | null;
  repeatEvery: number;
  startDate: string;
  termMonths: number | null;
  status: "active" | "cancelled";
  cancelledOn: string | null;
}

export interface Schedule {
  /** The next charge on or after today, or null (prepaid, ended, cancelled). */
  nextCharge: string | null;
  /** When it ends (installments and prepaid), or null for one that renews until cancelled. */
  endDate: string | null;
  /** Charges still to come (installments), or null. */
  chargesLeft: number | null;
  /** What it costs a month on average while it lasts; 0 once it ended or was cancelled. */
  monthlyMinor: number;
  ended: boolean;
}

/** The n-th charge date (0 = the start) of a recurring subscription. Pure. */
function nthCharge(s: ScheduleInput, n: number): string {
  const every = Math.max(1, s.repeatEvery);
  if (s.frequency === "weekly") return addDays(s.startDate, n * 7 * every);
  if (s.frequency === "yearly") return addMonthsToDay(s.startDate, n * 12 * every);
  return addMonthsToDay(s.startDate, n * every);
}

/** When a subscription next charges, when it ends, and what it costs a month. Pure. */
export function subscriptionSchedule(s: ScheduleInput, today: string): Schedule {
  const cancelled = s.status === "cancelled";
  const every = Math.max(1, s.repeatEvery);
  if (s.billing === "prepaid") {
    const term = Math.max(1, s.termMonths ?? 1);
    const endDate = addMonthsToDay(s.startDate, term);
    const ended = cancelled || endDate <= today;
    return {
      nextCharge: !cancelled && s.startDate >= today ? s.startDate : null,
      endDate,
      chargesLeft: null,
      monthlyMinor: ended ? 0 : Math.round(s.amountMinor / term),
      ended,
    };
  }
  if (s.billing === "installments") {
    const term = Math.max(1, s.termMonths ?? 1);
    let n = 0;
    while (n < term && addMonthsToDay(s.startDate, n) < today) n += 1;
    const endDate = addMonthsToDay(s.startDate, term);
    const ended = cancelled || n >= term;
    return {
      nextCharge: ended ? null : addMonthsToDay(s.startDate, n),
      endDate,
      chargesLeft: ended ? 0 : term - n,
      monthlyMinor: ended ? 0 : s.amountMinor,
      ended,
    };
  }
  let n = 0;
  // Step to the first charge on or after today (a safe upper bound for old weekly ones).
  while (nthCharge(s, n) < today && n < 10_000) n += 1;
  const perMonth =
    s.frequency === "weekly"
      ? (s.amountMinor * 52) / 12 / every
      : s.frequency === "yearly"
        ? s.amountMinor / 12 / every
        : s.amountMinor / every;
  return {
    nextCharge: cancelled ? null : nthCharge(s, n),
    endDate: null,
    chargesLeft: null,
    monthlyMinor: cancelled ? 0 : Math.round(perMonth),
    ended: cancelled,
  };
}

export interface TrackedSubscriptionInput {
  name: string;
  amountMinor: number;
  billing: Billing;
  frequency?: SubFrequency | null | undefined;
  repeatEvery?: number | undefined;
  startDate: string;
  termMonths?: number | null | undefined;
  accountId?: number | null | undefined;
  categoryId?: number | null | undefined;
  email?: string | null | undefined;
  username?: string | null | undefined;
  website?: string | null | undefined;
  notes?: string | null | undefined;
  /** A recurring series found in the history this is (see recurring.service). */
  recurringKey?: string | null | undefined;
  /** When a free trial ends. */
  trialEndsOn?: string | null | undefined;
  /** What its payments' merchant contains, to find them in the history. */
  paymentMatch?: string | null | undefined;
}

export interface TrackedSubscriptionDto extends Schedule {
  id: number;
  name: string;
  amountMinor: number;
  billing: Billing;
  frequency: SubFrequency | null;
  repeatEvery: number;
  startDate: string;
  termMonths: number | null;
  accountId: number | null;
  accountName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  email: string | null;
  username: string | null;
  website: string | null;
  notes: string | null;
  status: "active" | "cancelled";
  cancelledOn: string | null;
  recurringKey: string | null;
  trialEndsOn: string | null;
  paymentMatch: string | null;
  /** Its upcoming charges show on the calendar. */
  onCalendar: boolean;
}

export interface TrackedSubscriptionList {
  subscriptions: TrackedSubscriptionDto[];
  totals: { monthlyMinor: number; yearlyMinor: number; active: number };
}

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

function check(db: AppDb, input: TrackedSubscriptionInput): void {
  if (!clean(input.name)) throw new AppError(400, "invalid_name", "Enter the subscription's name.");
  if (
    !Number.isInteger(input.amountMinor) ||
    // 0 is allowed: a free subscription kept only to keep track of it.
    input.amountMinor < 0 ||
    input.amountMinor > MAX_AMOUNT
  ) {
    throw new AppError(400, "invalid_amount", "Enter what each charge costs (0 if it is free).");
  }
  if (!BILLINGS.includes(input.billing)) {
    throw new AppError(400, "invalid_billing", "Choose how it is billed.");
  }
  if (!DAY.test(input.startDate)) {
    throw new AppError(400, "invalid_date", "Choose the day it starts.");
  }
  if (input.billing === "recurring") {
    if (!input.frequency || !SUB_FREQUENCIES.includes(input.frequency)) {
      throw new AppError(400, "invalid_repeat", "Choose how often it renews.");
    }
    const every = input.repeatEvery ?? 1;
    if (!Number.isInteger(every) || every < 1 || every > 36) {
      throw new AppError(400, "invalid_repeat", "Repeat every 1 to 36 periods.");
    }
  } else {
    const term = input.termMonths;
    if (!Number.isInteger(term) || term! < 1 || term! > MAX_TERM_MONTHS) {
      throw new AppError(400, "invalid_term", "Enter how many months it lasts (1 to 120).");
    }
  }
  if (clean(input.trialEndsOn) && !DAY.test(input.trialEndsOn!.trim())) {
    throw new AppError(400, "invalid_date", "Choose the day the trial ends.");
  }
  if (input.accountId) {
    const a = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.accountId));
    if (!a.get()) throw new AppError(400, "unknown_account", "That account does not exist.");
  }
  if (input.categoryId) {
    const c = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, input.categoryId));
    if (!c.get()) throw new AppError(400, "unknown_category", "That category does not exist.");
  }
}

function columnsOf(input: TrackedSubscriptionInput) {
  const recurring = input.billing === "recurring";
  return {
    name: clean(input.name)!,
    amountMinor: input.amountMinor,
    billing: input.billing,
    frequency: recurring ? (input.frequency ?? "monthly") : null,
    repeatEvery: recurring ? (input.repeatEvery ?? 1) : 1,
    startDate: input.startDate,
    termMonths: recurring ? null : (input.termMonths ?? null),
    accountId: input.accountId ?? null,
    categoryId: input.categoryId ?? null,
    email: clean(input.email),
    username: clean(input.username),
    website: clean(input.website),
    notes: clean(input.notes),
    trialEndsOn: clean(input.trialEndsOn),
    paymentMatch: clean(input.paymentMatch),
  };
}

type Row = typeof trackedSubscriptions.$inferSelect;

function scheduleOf(row: Row): ScheduleInput {
  return {
    amountMinor: row.amountMinor,
    billing: row.billing as Billing,
    frequency: row.frequency as SubFrequency | null,
    repeatEvery: row.repeatEvery,
    startDate: row.startDate,
    termMonths: row.termMonths,
    status: row.status as "active" | "cancelled",
    cancelledOn: row.cancelledOn,
  };
}

/**
 * Keeps the planned transaction for a subscription's upcoming charges in step: one the user added,
 * still active, with charges to come, has one starting at its next charge; anything else has none.
 */
function syncPlanned(db: AppDb, id: number, today: string, now: string): void {
  const row = db.select().from(trackedSubscriptions).where(eq(trackedSubscriptions.id, id)).get()!;
  if (row.plannedId !== null) {
    try {
      deletePlanned(db, row.plannedId);
    } catch {
      // Already gone (deleted from the calendar): nothing to remove.
    }
  }
  const schedule = subscriptionSchedule(scheduleOf(row), today);
  let plannedId: number | null = null;
  // A free one has no charges to show on the calendar.
  if (
    row.recurringKey === null &&
    row.status === "active" &&
    row.amountMinor > 0 &&
    schedule.nextCharge !== null
  ) {
    const start = schedule.nextCharge;
    const base: PlannedInput = {
      merchant: row.name,
      amountMinor: row.amountMinor,
      direction: "out",
      accountId: row.accountId,
      categoryId: row.categoryId,
      notes: "Subscription",
      startDate: start,
      frequency: "once",
    };
    const monthly = { monthMode: "day" as const, dayOfMonth: Number(start.slice(8)) };
    const input: PlannedInput =
      row.billing === "prepaid"
        ? base
        : row.billing === "installments"
          ? { ...base, frequency: "monthly", ...monthly, maxCount: schedule.chargesLeft }
          : row.frequency === "weekly"
            ? {
                ...base,
                frequency: "weekly",
                repeatEvery: row.repeatEvery,
                weekdays: [new Date(`${start}T00:00:00Z`).getUTCDay()],
              }
            : row.frequency === "yearly"
              ? { ...base, frequency: "yearly", repeatEvery: row.repeatEvery }
              : { ...base, frequency: "monthly", repeatEvery: row.repeatEvery, ...monthly };
    plannedId = createPlanned(db, input, now).id;
  }
  db.update(trackedSubscriptions).set({ plannedId }).where(eq(trackedSubscriptions.id, id)).run();
}

export function listTrackedSubscriptions(
  db: AppDb,
  today: string = new Date().toISOString().slice(0, 10),
): TrackedSubscriptionList {
  const rows = db
    .select({
      row: trackedSubscriptions,
      accountName: accounts.name,
      categoryName: categories.name,
    })
    .from(trackedSubscriptions)
    .leftJoin(accounts, eq(accounts.id, trackedSubscriptions.accountId))
    .leftJoin(categories, eq(categories.id, trackedSubscriptions.categoryId))
    .orderBy(trackedSubscriptions.status, sql`lower(${trackedSubscriptions.name})`)
    .all();
  const subscriptions = rows.map(({ row, accountName, categoryName }): TrackedSubscriptionDto => {
    return {
      ...subscriptionSchedule(scheduleOf(row), today),
      id: row.id,
      name: row.name,
      amountMinor: row.amountMinor,
      billing: row.billing as Billing,
      frequency: row.frequency as SubFrequency | null,
      repeatEvery: row.repeatEvery,
      startDate: row.startDate,
      termMonths: row.termMonths,
      accountId: row.accountId,
      accountName,
      categoryId: row.categoryId,
      categoryName,
      email: row.email,
      username: row.username,
      website: row.website,
      notes: row.notes,
      status: row.status as "active" | "cancelled",
      cancelledOn: row.cancelledOn,
      recurringKey: row.recurringKey,
      trialEndsOn: row.trialEndsOn,
      paymentMatch: row.paymentMatch,
      onCalendar: row.plannedId !== null,
    };
  });
  const live = subscriptions.filter((s) => !s.ended);
  const monthlyMinor = live.reduce((n, s) => n + s.monthlyMinor, 0);
  return {
    subscriptions,
    totals: { monthlyMinor, yearlyMinor: monthlyMinor * 12, active: live.length },
  };
}

function requireRow(db: AppDb, id: number): Row {
  const row = db.select().from(trackedSubscriptions).where(eq(trackedSubscriptions.id, id)).get();
  if (!row) throw notFound("That subscription");
  return row;
}

export function createTrackedSubscription(
  db: AppDb,
  input: TrackedSubscriptionInput,
  today: string = new Date().toISOString().slice(0, 10),
  now: string = new Date().toISOString(),
): TrackedSubscriptionList {
  check(db, input);
  const key = clean(input.recurringKey);
  if (key) {
    const taken = db
      .select({ id: trackedSubscriptions.id })
      .from(trackedSubscriptions)
      .where(eq(trackedSubscriptions.recurringKey, key))
      .get();
    if (taken) throw new AppError(409, "already_tracked", "That subscription is already tracked.");
  }
  db.transaction((tx) => {
    const created = tx
      .insert(trackedSubscriptions)
      .values({
        ...columnsOf(input),
        recurringKey: key,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: trackedSubscriptions.id })
      .get();
    syncPlanned(tx as unknown as AppDb, created.id, today, now);
  });
  return listTrackedSubscriptions(db, today);
}

export function updateTrackedSubscription(
  db: AppDb,
  id: number,
  input: TrackedSubscriptionInput,
  today: string = new Date().toISOString().slice(0, 10),
  now: string = new Date().toISOString(),
): TrackedSubscriptionList {
  requireRow(db, id);
  check(db, input);
  db.transaction((tx) => {
    tx.update(trackedSubscriptions)
      .set({ ...columnsOf(input), updatedAt: now })
      .where(eq(trackedSubscriptions.id, id))
      .run();
    syncPlanned(tx as unknown as AppDb, id, today, now);
  });
  return listTrackedSubscriptions(db, today);
}

/** Marks it cancelled from `on` (its upcoming charges leave the calendar), or active again. */
export function setTrackedSubscriptionStatus(
  db: AppDb,
  id: number,
  status: "active" | "cancelled",
  on: string | null,
  today: string = new Date().toISOString().slice(0, 10),
  now: string = new Date().toISOString(),
): TrackedSubscriptionList {
  requireRow(db, id);
  if (status === "cancelled" && on !== null && !DAY.test(on)) {
    throw new AppError(400, "invalid_date", "Choose the day it was cancelled.");
  }
  db.transaction((tx) => {
    tx.update(trackedSubscriptions)
      .set({
        status,
        cancelledOn: status === "cancelled" ? (on ?? today) : null,
        updatedAt: now,
      })
      .where(eq(trackedSubscriptions.id, id))
      .run();
    syncPlanned(tx as unknown as AppDb, id, today, now);
  });
  return listTrackedSubscriptions(db, today);
}

/** Stops tracking it, and removes its upcoming charges from the calendar. */
export function deleteTrackedSubscription(db: AppDb, id: number): void {
  const row = requireRow(db, id);
  db.transaction((tx) => {
    if (row.plannedId !== null) {
      try {
        deletePlanned(tx as unknown as AppDb, row.plannedId);
      } catch {
        // Already gone.
      }
    }
    tx.delete(trackedSubscriptions).where(eq(trackedSubscriptions.id, id)).run();
  });
}
