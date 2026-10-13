import { and, asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  categories,
  dayNotes,
  plannedExceptions,
  plannedTransactions,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, firstOfMonth, isRealDate, lastOfMonth } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import {
  describeRule,
  FREQUENCIES,
  nextOccurrences,
  occurrences,
  ruleProblem,
  type Frequency,
  type RepeatRule,
} from "../utils/recurrence.js";
import { listAccounts } from "./account.service.js";
import {
  dateOf,
  DEBT_KIND,
  debtPaidSum,
  debtAccountsTracked,
  summarize,
  type DateBasis,
} from "./analytics.service.js";
import { createManualTransaction } from "./manual-transaction.service.js";
import type { TransactionDto } from "./transaction.service.js";
import { getSettings } from "./settings.service.js";
import { accountScope } from "./account-scope.js";
import {
  matchesPendingManual,
  pendingManualTransactions,
  projectedDate,
} from "./pending-manual.service.js";

/**
 * The calendar: a note for any day, transactions the user expects (once or on a schedule), and for
 * any day or span of days the balance, what changed, and what happened.
 *
 * Signs: `amount_minor` is positive when money leaves an account, as everywhere else. A planned
 * transaction is stored that way too and shown to the client as a positive amount plus a direction.
 */

const MAX_NOTE = 4000;
const MAX_AMOUNT = 100_000_000_000;
/** The longest span the summary and the expected list answer for. */
const MAX_SPAN_DAYS = 3660;

const clean = (text: string | null | undefined): string | null => {
  const t = text?.trim() ?? "";
  return t === "" ? null : t;
};

function requireDate(value: string, what = "date"): void {
  if (!isRealDate(value)) {
    throw new AppError(400, "invalid_date", `Enter a real ${what} as YYYY-MM-DD.`);
  }
}

function requireSpan(from: string, to: string): void {
  requireDate(from, "start date");
  requireDate(to, "end date");
  if (to < from) throw new AppError(400, "invalid_range", "The end date is before the start date.");
  if (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 >
    MAX_SPAN_DAYS
  ) {
    throw new AppError(400, "range_too_long", "Choose a span of at most ten years.");
  }
}

// ---- Day notes -------------------------------------------------------------------------

export interface DayNote {
  date: string;
  note: string;
  updatedAt: string;
}

export function listNotes(db: AppDb, from: string, to: string): DayNote[] {
  requireSpan(from, to);
  return db
    .select({ date: dayNotes.date, note: dayNotes.note, updatedAt: dayNotes.updatedAt })
    .from(dayNotes)
    .where(and(sql`${dayNotes.date} >= ${from}`, sql`${dayNotes.date} <= ${to}`))
    .orderBy(asc(dayNotes.date))
    .all();
}

/** Saves the note for a day; an empty note removes it. Returns the note, or null when removed. */
export function setNote(db: AppDb, date: string, note: string, now: string): DayNote | null {
  requireDate(date);
  const text = note.trim();
  if (text.length > MAX_NOTE) {
    throw new AppError(400, "note_too_long", `Keep a note under ${MAX_NOTE} characters.`);
  }
  if (text === "") {
    db.delete(dayNotes).where(eq(dayNotes.date, date)).run();
    return null;
  }
  db.insert(dayNotes)
    .values({ date, note: text, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: dayNotes.date, set: { note: text, updatedAt: now } })
    .run();
  return { date, note: text, updatedAt: now };
}

// ---- Expected (planned) transactions ---------------------------------------------------

export interface PlannedInput {
  merchant: string;
  /** A positive amount; `direction` says which way the money will move. */
  amountMinor: number;
  direction: "out" | "in";
  accountId?: number | null | undefined;
  categoryId?: number | null | undefined;
  person?: string | null | undefined;
  notes?: string | null | undefined;
  startDate: string;
  frequency: Frequency;
  repeatEvery?: number | undefined;
  weekdays?: number[] | undefined;
  monthMode?: "day" | "weekday" | null | undefined;
  dayOfMonth?: number | null | undefined;
  nthWeek?: number | null | undefined;
  endDate?: string | null | undefined;
  maxCount?: number | null | undefined;
}

export interface PlannedDto {
  id: number;
  merchant: string;
  /** Always positive. */
  amountMinor: number;
  direction: "out" | "in";
  accountId: number | null;
  accountName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  person: string | null;
  notes: string | null;
  startDate: string;
  frequency: Frequency;
  repeatEvery: number;
  weekdays: number[];
  monthMode: "day" | "weekday" | null;
  dayOfMonth: number | null;
  nthWeek: number | null;
  endDate: string | null;
  maxCount: number | null;
  /** The rule in words. */
  repeats: string;
  /** The next date on or after today that is still expected, if any. */
  nextDate: string | null;
}

export interface PlannedOccurrence {
  plannedId: number;
  date: string;
  merchant: string;
  amountMinor: number;
  direction: "out" | "in";
  accountId: number | null;
  accountName: string | null;
  accountType: string | null;
  categoryName: string | null;
  person: string | null;
  repeats: string;
  recurring: boolean;
  /** Whether the account is kept by hand, so the occurrence can be recorded as a transaction. */
  canRecord: boolean;
  status: "expected" | "skipped" | "done";
}

type PlannedRow = typeof plannedTransactions.$inferSelect;

const parseWeekdays = (csv: string | null): number[] =>
  csv
    ? csv
        .split(",")
        .filter((s) => s !== "")
        .map(Number)
    : [];

function ruleOf(row: PlannedRow): RepeatRule {
  return {
    startDate: row.startDate,
    frequency: row.frequency as Frequency,
    repeatEvery: row.repeatEvery,
    weekdays: parseWeekdays(row.weekdays),
    monthMode: (row.monthMode as "day" | "weekday" | null) ?? null,
    dayOfMonth: row.dayOfMonth,
    nthWeek: row.nthWeek,
    endDate: row.endDate,
    maxCount: row.maxCount,
  };
}

function ruleOfInput(input: PlannedInput): RepeatRule {
  const frequency = input.frequency;
  return {
    startDate: input.startDate,
    frequency,
    repeatEvery: frequency === "once" ? 1 : (input.repeatEvery ?? 1),
    weekdays:
      frequency === "weekly" || (frequency === "monthly" && input.monthMode === "weekday")
        ? [...new Set(input.weekdays ?? [])].sort((a, b) => a - b)
        : [],
    monthMode: frequency === "monthly" ? (input.monthMode ?? "day") : null,
    dayOfMonth:
      frequency === "monthly" && (input.monthMode ?? "day") === "day"
        ? (input.dayOfMonth ?? null)
        : null,
    nthWeek:
      frequency === "monthly" && input.monthMode === "weekday" ? (input.nthWeek ?? null) : null,
    endDate: frequency === "once" ? null : (input.endDate ?? null),
    maxCount: frequency === "once" ? null : (input.maxCount ?? null),
  };
}

const todayOf = (): string => new Date().toISOString().slice(0, 10);

function describe(db: AppDb, row: PlannedRow, resolved: Set<string>): PlannedDto {
  const rule = ruleOf(row);
  const account = row.accountId
    ? db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, row.accountId)).get()
    : undefined;
  const category = row.categoryId
    ? db
        .select({ name: categories.name })
        .from(categories)
        .where(eq(categories.id, row.categoryId))
        .get()
    : undefined;
  // Look ahead for the next occurrence that has not been skipped or marked done.
  const upcoming = nextOccurrences(rule, todayOf(), 400).find((d) => !resolved.has(d)) ?? null;
  return {
    id: row.id,
    merchant: row.merchant,
    amountMinor: Math.abs(row.amountMinor),
    direction: row.amountMinor > 0 ? "out" : "in",
    accountId: row.accountId,
    accountName: account?.name ?? null,
    categoryId: row.categoryId,
    categoryName: category?.name ?? null,
    person: row.person,
    notes: row.notes,
    startDate: row.startDate,
    frequency: rule.frequency,
    repeatEvery: rule.repeatEvery,
    weekdays: rule.weekdays,
    monthMode: rule.monthMode,
    dayOfMonth: rule.dayOfMonth,
    nthWeek: rule.nthWeek,
    endDate: rule.endDate,
    maxCount: rule.maxCount,
    repeats: describeRule(rule),
    nextDate: upcoming,
  };
}

function resolvedDates(db: AppDb, plannedId: number): Map<string, "skipped" | "done"> {
  return new Map(
    db
      .select({ date: plannedExceptions.date, kind: plannedExceptions.kind })
      .from(plannedExceptions)
      .where(eq(plannedExceptions.plannedId, plannedId))
      .all()
      .map((e) => [e.date, e.kind as "skipped" | "done"]),
  );
}

export function listPlanned(db: AppDb): PlannedDto[] {
  return db
    .select()
    .from(plannedTransactions)
    .orderBy(asc(plannedTransactions.id))
    .all()
    .map((row) => describe(db, row, new Set(resolvedDates(db, row.id).keys())));
}

function getPlannedRow(db: AppDb, id: number): PlannedRow {
  const row = db.select().from(plannedTransactions).where(eq(plannedTransactions.id, id)).get();
  if (!row) throw notFound("Expected transaction");
  return row;
}

export function getPlanned(db: AppDb, id: number): PlannedDto {
  return describe(db, getPlannedRow(db, id), new Set(resolvedDates(db, id).keys()));
}

function checkPlannedInput(db: AppDb, input: PlannedInput): RepeatRule {
  if (!clean(input.merchant)) {
    throw new AppError(400, "invalid_merchant", "Enter who the payment is with.");
  }
  if (
    !Number.isInteger(input.amountMinor) ||
    input.amountMinor < 1 ||
    input.amountMinor > MAX_AMOUNT
  ) {
    throw new AppError(
      400,
      "invalid_amount",
      "Enter the amount as a positive number; choose money in or money out separately.",
    );
  }
  if (!FREQUENCIES.includes(input.frequency)) {
    throw new AppError(400, "invalid_repeat", "Choose how often it repeats.");
  }
  const rule = ruleOfInput(input);
  const problem = ruleProblem(rule);
  if (problem) throw new AppError(400, "invalid_repeat", problem);
  if (input.accountId) {
    const account = db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, input.accountId))
      .get();
    if (!account) throw new AppError(400, "unknown_account", "That account does not exist.");
  }
  if (input.categoryId) {
    const category = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, input.categoryId))
      .get();
    if (!category) throw new AppError(400, "unknown_category", "That category does not exist.");
  }
  return rule;
}

function columnsOf(input: PlannedInput, rule: RepeatRule) {
  return {
    accountId: input.accountId ?? null,
    merchant: clean(input.merchant)!,
    amountMinor: input.direction === "out" ? input.amountMinor : -input.amountMinor,
    categoryId: input.categoryId ?? null,
    person: clean(input.person),
    notes: clean(input.notes),
    startDate: rule.startDate,
    frequency: rule.frequency,
    repeatEvery: rule.repeatEvery,
    weekdays: rule.weekdays.length > 0 ? rule.weekdays.join(",") : null,
    monthMode: rule.monthMode,
    dayOfMonth: rule.dayOfMonth,
    nthWeek: rule.nthWeek,
    endDate: rule.endDate,
    maxCount: rule.maxCount,
  };
}

export function createPlanned(db: AppDb, input: PlannedInput, now: string): PlannedDto {
  const rule = checkPlannedInput(db, input);
  const created = db
    .insert(plannedTransactions)
    .values({ ...columnsOf(input, rule), createdAt: now, updatedAt: now })
    .returning({ id: plannedTransactions.id })
    .get();
  return getPlanned(db, created.id);
}

/** Replaces the whole definition. Occurrences already skipped or marked done keep that status. */
export function updatePlanned(db: AppDb, id: number, input: PlannedInput, now: string): PlannedDto {
  getPlannedRow(db, id);
  const rule = checkPlannedInput(db, input);
  db.update(plannedTransactions)
    .set({ ...columnsOf(input, rule), updatedAt: now })
    .where(eq(plannedTransactions.id, id))
    .run();
  return getPlanned(db, id);
}

export function deletePlanned(db: AppDb, id: number): void {
  getPlannedRow(db, id);
  db.delete(plannedTransactions).where(eq(plannedTransactions.id, id)).run();
}

/** The next dates a rule would produce, so the form can show what "every 2nd Tuesday" means. */
export function previewRule(input: PlannedInput, from: string, howMany: number): string[] {
  const rule = ruleOfInput(input);
  const problem = ruleProblem(rule);
  if (problem) throw new AppError(400, "invalid_repeat", problem);
  requireDate(from, "date");
  return nextOccurrences(rule, from, Math.min(Math.max(howMany, 1), 20));
}

/**
 * The occurrences between two dates. Skipped and done ones are left out unless asked for. With an
 * account, only expected transactions on that account are included.
 */
export function listOccurrences(
  db: AppDb,
  from: string,
  to: string,
  options: { accountId?: number | undefined; includeResolved?: boolean | undefined } = {},
): PlannedOccurrence[] {
  requireSpan(from, to);
  const rows = db
    .select({
      row: plannedTransactions,
      accountName: accounts.name,
      accountType: accounts.type,
      accountPlaidItemId: accounts.plaidItemId,
      accountHidden: accounts.hidden,
      categoryName: categories.name,
    })
    .from(plannedTransactions)
    .leftJoin(accounts, eq(accounts.id, plannedTransactions.accountId))
    .leftJoin(categories, eq(categories.id, plannedTransactions.categoryId))
    .orderBy(asc(plannedTransactions.id))
    .all();

  const found: PlannedOccurrence[] = [];
  for (const r of rows) {
    if (options.accountId !== undefined && r.row.accountId !== options.accountId) continue;
    // Something expected on a hidden account stays out of sight along with the account.
    if (r.accountHidden && options.accountId === undefined) continue;
    const rule = ruleOf(r.row);
    const resolved = resolvedDates(db, r.row.id);
    for (const date of occurrences(rule, from, to)) {
      const status = resolved.get(date) ?? "expected";
      if (status !== "expected" && !options.includeResolved) continue;
      found.push({
        plannedId: r.row.id,
        date,
        merchant: r.row.merchant,
        amountMinor: Math.abs(r.row.amountMinor),
        direction: r.row.amountMinor > 0 ? "out" : "in",
        accountId: r.row.accountId,
        accountName: r.accountName,
        accountType: r.accountType,
        categoryName: r.categoryName,
        person: r.row.person,
        repeats: describeRule(rule),
        recurring: rule.frequency !== "once",
        canRecord: r.row.accountId !== null && r.accountPlaidItemId === null,
        status,
      });
    }
  }
  return found.sort((a, b) => a.date.localeCompare(b.date) || a.plannedId - b.plannedId);
}

function requireOccurrence(db: AppDb, plannedId: number, date: string): PlannedRow {
  const row = getPlannedRow(db, plannedId);
  requireDate(date);
  if (!occurrences(ruleOf(row), date, date).includes(date)) {
    throw new AppError(404, "not_an_occurrence", "That date is not one of its occurrences.");
  }
  return row;
}

/** Marks one occurrence skipped or done, or (with null) expected again. */
export function setOccurrenceStatus(
  db: AppDb,
  plannedId: number,
  date: string,
  kind: "skipped" | "done" | null,
  now: string,
): void {
  requireOccurrence(db, plannedId, date);
  if (kind === null) {
    db.delete(plannedExceptions)
      .where(and(eq(plannedExceptions.plannedId, plannedId), eq(plannedExceptions.date, date)))
      .run();
    return;
  }
  db.insert(plannedExceptions)
    .values({ plannedId, date, kind, createdAt: now })
    .onConflictDoUpdate({
      target: [plannedExceptions.plannedId, plannedExceptions.date],
      set: { kind },
    })
    .run();
}

/**
 * Turns one occurrence into a real transaction (on an account kept by hand) and marks it done.
 * A connected bank account cannot take typed-in transactions: its real ones arrive on their own.
 */
export function recordOccurrence(
  db: AppDb,
  plannedId: number,
  date: string,
  now: string,
): TransactionDto {
  const row = requireOccurrence(db, plannedId, date);
  if (!row.accountId) {
    throw new AppError(
      409,
      "no_account",
      "Choose an account for this expected transaction before recording it.",
    );
  }
  return db.transaction((tx) => {
    const created = createManualTransaction(
      tx as unknown as AppDb,
      {
        accountId: row.accountId!,
        date,
        merchant: row.merchant,
        amountMinor: Math.abs(row.amountMinor),
        direction: row.amountMinor > 0 ? "out" : "in",
        categoryId: row.categoryId,
        recipient: row.amountMinor > 0 ? row.person : null,
        sender: row.amountMinor < 0 ? row.person : null,
        notes: row.notes,
      },
      now,
    );
    setOccurrenceStatus(tx as unknown as AppDb, plannedId, date, "done", now);
    return created;
  });
}

// ---- Expected events: planned occurrences and pending manual entries, as one list ----------

/**
 * Something still to happen to a balance: an occurrence of a planned transaction, or a manual
 * entry that is still pending (projected onto the day it can take effect). The grid, the expected
 * totals and the Expected list all come from this one list, so they always agree.
 */
export interface CalendarEvent {
  /** Stable across requests: `planned:<id>:<date>` or `pending:<transaction id>`. */
  id: string;
  source: "planned" | "pending";
  /** The day it is due (planned) or projected to take effect (pending). */
  date: string;
  /** The date it was entered with; differs from `date` for a pending entry carried forward. */
  originalDate: string;
  merchant: string;
  /** Always positive; `direction` says which way the money moves. */
  amountMinor: number;
  direction: "out" | "in";
  accountId: number | null;
  accountName: string | null;
  accountType: string | null;
  categoryName: string | null;
  status: "expected" | "skipped" | "done";
  /** Planned only (null for a pending entry). */
  plannedId: number | null;
  person: string | null;
  repeats: string | null;
  recurring: boolean;
  canRecord: boolean;
  /** Pending only: the transaction to open or post. */
  transactionId: number | null;
}

/**
 * The expected events between two dates. A planned occurrence that a pending entry already stands
 * for (same day, amount, merchant and account) is left out, so it counts once. Skipped and done
 * occurrences are included only when asked for.
 */
export function expectedEvents(
  db: AppDb,
  from: string,
  to: string,
  options: {
    accountId?: number | undefined;
    includeResolved?: boolean | undefined;
    today?: string | undefined;
  } = {},
): CalendarEvent[] {
  requireSpan(from, to);
  const today = options.today ?? todayOf();
  const pending = pendingManualTransactions(db, {
    to,
    currency: getSettings(db).currency,
    accountId: options.accountId,
  });
  const events: CalendarEvent[] = [];
  for (const o of listOccurrences(db, from, to, options)) {
    if (o.status === "expected" && matchesPendingManual(pending, o)) continue;
    events.push({
      id: `planned:${o.plannedId}:${o.date}`,
      source: "planned",
      date: o.date,
      originalDate: o.date,
      merchant: o.merchant,
      amountMinor: o.amountMinor,
      direction: o.direction,
      accountId: o.accountId,
      accountName: o.accountName,
      accountType: o.accountType,
      categoryName: o.categoryName,
      status: o.status,
      plannedId: o.plannedId,
      person: o.person,
      repeats: o.repeats,
      recurring: o.recurring,
      canRecord: o.canRecord,
      transactionId: null,
    });
  }
  for (const t of pending) {
    const date = projectedDate(t.date, today);
    if (date < from || date > to) continue;
    events.push({
      id: `pending:${t.id}`,
      source: "pending",
      date,
      originalDate: t.date,
      merchant: t.merchant,
      amountMinor: Math.abs(t.amountMinor),
      direction: t.amountMinor > 0 ? "out" : "in",
      accountId: t.accountId,
      accountName: t.accountName,
      accountType: t.accountType,
      categoryName: t.categoryName,
      status: "expected",
      plannedId: null,
      person: null,
      repeats: null,
      recurring: false,
      canRecord: false,
      transactionId: t.id,
    });
  }
  return events.sort(
    (a, b) => a.date.localeCompare(b.date) || a.merchant.localeCompare(b.merchant),
  );
}

/** Count and totals of the outstanding events. */
function expectedTotals(events: CalendarEvent[]): {
  count: number;
  outflowMinor: number;
  inflowMinor: number;
} {
  const open = events.filter((e) => e.status === "expected");
  return {
    count: open.length,
    outflowMinor: open.filter((e) => e.direction === "out").reduce((s, e) => s + e.amountMinor, 0),
    inflowMinor: open.filter((e) => e.direction === "in").reduce((s, e) => s + e.amountMinor, 0),
  };
}

// ---- Month overlay: notes and expected amounts for the grid ------------------------------

export interface CalendarOverlay {
  month: string;
  notes: Record<string, string>;
  expected: Array<{
    date: string;
    count: number;
    outflowMinor: number;
    inflowMinor: number;
    /** Up to three of the day's events, largest first. */
    items: Array<{
      merchant: string;
      amountMinor: number;
      direction: "out" | "in";
      source: "planned" | "pending";
    }>;
  }>;
}

export function calendarOverlay(
  db: AppDb,
  month: string,
  accountId?: number,
  today: string = todayOf(),
): CalendarOverlay {
  const from = firstOfMonth(month);
  const to = lastOfMonth(month);
  const notes: Record<string, string> = {};
  for (const n of listNotes(db, from, to)) notes[n.date] = n.note;

  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of expectedEvents(db, from, to, { accountId, today })) {
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  }
  return {
    month,
    notes,
    expected: [...byDate.entries()].map(([date, events]) => ({
      date,
      ...expectedTotals(events),
      // The largest first, for the day cell to name.
      items: [...events]
        .sort((a, b) => b.amountMinor - a.amountMinor)
        .slice(0, 3)
        .map((e) => ({
          merchant: e.merchant,
          amountMinor: e.amountMinor,
          direction: e.direction,
          source: e.source,
        })),
    })),
  };
}

// ---- Balances and a summary for a day or a span ------------------------------------------

export interface PeriodSummary {
  from: string;
  to: string;
  currency: string;
  balance: {
    /** The balance at the end of the day before `from` (null when no balance is known). */
    startMinor: number | null;
    /** The balance at the end of `to`. */
    endMinor: number | null;
    changeMinor: number | null;
    /** True when the period reaches past today: the end balance then includes expected items. */
    projected: boolean;
    accountsCounted: number;
    accountsWithoutBalance: number;
    /** Cash accounts on their own (null when none is counted). */
    cash: { startMinor: number | null; endMinor: number | null };
    /** What is owed on the counted cards (null when none is counted). Cash minus this is the total. */
    cardDebt: { startMinor: number | null; endMinor: number | null };
    /** For a projected end: the balance today and the expected money in and out after it. */
    projection: { todayMinor: number; inMinor: number; outMinor: number } | null;
    /** The accounts the balance is made of, and those left out for want of a balance. */
    accounts: Array<{ name: string; type: string }>;
    withoutBalance: Array<{ name: string; type: string }>;
  };
  /** What is owed on credit cards and loans: lower is better. */
  debt: {
    startMinor: number | null;
    endMinor: number | null;
    /** Negative when the debt went down. */
    changeMinor: number | null;
    accountsCounted: number;
  };
  /** Payments toward credit cards and loans in the period. They lower the debt and are not spending. */
  debtPaidMinor: number;
  /** What came in or went out, pending included, but not moves between your own accounts or debt payments. */
  moneyInMinor: number;
  moneyOutMinor: number;
  transactionCount: number;
  pendingCount: number;
  /** The same period by the app's definition of spending and income (transfers left out). */
  spendingMinor: number;
  incomeMinor: number;
  topCategories: Array<{ label: string; color: string | null; spendingMinor: number }>;
  expected: { count: number; outflowMinor: number; inflowMinor: number };
  notes: DayNote[];
}

interface Totals {
  in: number | null;
  out: number | null;
  debt: number | null;
  funding: number | null;
  n: number;
  pending: number | null;
}

/**
 * The balance of the chosen accounts at the end of a day: the balance now, wound back by the
 * posted transactions after that day (or forward by expected ones, for a day in the future). It is
 * worked out from the transactions the app has, so it is only as good as that history.
 */
export function periodSummary(
  db: AppDb,
  from: string,
  to: string,
  accountId: number | undefined,
  environment: string,
  today: string = todayOf(),
  dateBasis: DateBasis = "transaction",
): PeriodSummary {
  requireSpan(from, to);
  const settings = getSettings(db);
  const currency = settings.currency;

  // Which accounts count towards the balance: cash accounts and cards with a known balance.
  const candidates = listAccounts(db).filter(
    (a) =>
      (a.itemId === null || a.connectionEnvironment === environment) &&
      (a.type === "depository" || a.type === "credit") &&
      a.currency === currency &&
      // All accounts that count toward totals, or the one asked for (a gift card's own balance).
      (accountId === undefined ? a.countsInTotals : a.id === accountId),
  );
  const counted = candidates.filter((a) => a.currentBalanceMinor !== null);
  const withoutBalance = candidates.length - counted.length;
  const currentNet = counted.reduce(
    (sum, a) => sum + (a.type === "credit" ? -a.currentBalanceMinor! : a.currentBalanceMinor!),
    0,
  );
  const ids = counted.map((a) => a.id);

  const postedAfter = (day: string): number => {
    if (ids.length === 0) return 0;
    const row = db.get<{ s: number | null }>(sql`
      select sum(amount_minor) as s from transactions
      where pending = 0 and date > ${day}
        and account_id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`);
    return row?.s ?? 0;
  };

  // Expected money between today and a future day, as its effect on the balance.
  const pending = pendingManualTransactions(db, { to, currency, accountId });
  const futureOccurrences =
    to > today
      ? listOccurrences(db, addDays(today, 1), to, { accountId }).filter(
          (o) => !matchesPendingManual(pending, o),
        )
      : [];
  const pendingEffect = (upTo: string, accountIds: number[]): number =>
    pending
      .filter((t) => t.date <= upTo && accountIds.includes(t.accountId))
      .reduce((sum, t) => sum - t.amountMinor, 0);
  const expectedEffect = (upTo: string): number =>
    futureOccurrences
      .filter((o) => o.date <= upTo)
      .reduce((sum, o) => sum + (o.direction === "out" ? -o.amountMinor : o.amountMinor), 0);

  const balanceAt = (day: string): number | null => {
    if (ids.length === 0) return null;
    // Net now, minus the net change since `day` (which is minus the amounts, per the sign rule).
    const base = currentNet + postedAfter(day);
    return day > today ? currentNet + expectedEffect(day) + pendingEffect(day, ids) : base;
  };

  const startMinor = balanceAt(addDays(from, -1));
  const endMinor = balanceAt(to);

  // The same balance split in two: what is owed on the counted cards, and cash (the rest). Both are
  // wound back or forward like the total, so cash minus card debt is always the total.
  const cards = counted.filter((a) => a.type === "credit");
  const cardIds = cards.map((a) => a.id);
  const cardOwedNow = cards.reduce((sum, a) => sum + a.currentBalanceMinor!, 0);
  const cardOwedAt = (day: string): number => {
    if (cardIds.length === 0) return 0;
    if (day > today) {
      const added = futureOccurrences
        .filter((o) => o.date <= day && o.accountId !== null && cardIds.includes(o.accountId))
        .reduce((sum, o) => sum + (o.direction === "out" ? o.amountMinor : -o.amountMinor), 0);
      return cardOwedNow + added - pendingEffect(day, cardIds);
    }
    const row = db.get<{ s: number | null }>(sql`
      select sum(amount_minor) as s from transactions
      where pending = 0 and date > ${day}
        and account_id in (${sql.join(
          cardIds.map((id) => sql`${id}`),
          sql`, `,
        )})`);
    return cardOwedNow - (row?.s ?? 0);
  };
  const hasCash = counted.some((a) => a.type !== "credit");
  const split = (day: string, net: number | null) => {
    const owed = cardOwedAt(day);
    return {
      cashMinor: net === null || !hasCash ? null : net + owed,
      cardDebtMinor: cardIds.length === 0 ? null : owed,
    };
  };
  const atStart = split(addDays(from, -1), startMinor);
  const atEnd = split(to, endMinor);

  // For a future end: today's balance and the expected money in and out that lead to it.
  const projection =
    to > today && ids.length > 0
      ? (() => {
          const upcoming = [
            ...futureOccurrences
              .filter((o) => o.date <= to)
              .map((o) => (o.direction === "out" ? o.amountMinor : -o.amountMinor)),
            ...pending.filter((t) => ids.includes(t.accountId)).map((t) => t.amountMinor),
          ];
          return {
            todayMinor: balanceAt(today)!,
            inMinor: upcoming.filter((a) => a < 0).reduce((s, a) => s - a, 0),
            outMinor: upcoming.filter((a) => a > 0).reduce((s, a) => s + a, 0),
          };
        })()
      : null;

  // What is owed on cards and loans, wound back the same way: owed now, less what was added since.
  const debtAccounts = listAccounts(db).filter(
    (a) =>
      (a.itemId === null || a.connectionEnvironment === environment) &&
      (a.type === "credit" || a.type === "loan") &&
      a.currency === currency &&
      a.currentBalanceMinor !== null &&
      (accountId === undefined || a.id === accountId),
  );
  const debtIds = debtAccounts.map((a) => a.id);
  const owedNow = debtAccounts.reduce((sum, a) => sum + a.currentBalanceMinor!, 0);
  const owedAt = (day: string): number | null => {
    if (debtIds.length === 0) return null;
    if (day > today) {
      const added = futureOccurrences
        .filter((o) => o.date <= day && o.accountId !== null && debtIds.includes(o.accountId))
        .reduce((sum, o) => sum + (o.direction === "out" ? o.amountMinor : -o.amountMinor), 0);
      return owedNow + added - pendingEffect(day, debtIds);
    }
    const row = db.get<{ s: number | null }>(sql`
      select sum(amount_minor) as s from transactions
      where pending = 0 and date > ${day}
        and account_id in (${sql.join(
          debtIds.map((id) => sql`${id}`),
          sql`, `,
        )})`);
    return owedNow - (row?.s ?? 0);
  };
  const owedStart = owedAt(addDays(from, -1));
  const owedEnd = owedAt(to);

  const totals = db.get<Totals>(sql`
    select
      -sum(case when t.amount_minor < 0 and ${DEBT_KIND} is null and t.is_transfer = 0 then t.amount_minor else 0 end) as "in",
      sum(case when t.amount_minor > 0 and ${DEBT_KIND} is null and t.is_transfer = 0 then t.amount_minor else 0 end) as "out",
      ${debtPaidSum(accountId !== undefined)} as debt,
      sum(case when ${DEBT_KIND} = 'funding_unpaired' then t.amount_minor else 0 end) as funding,
      count(*) as n, sum(t.pending) as pending
    from transactions t
      join accounts a on a.id = t.account_id
      left join plaid_items p on p.id = a.plaid_item_id
    where ${dateOf(dateBasis)} >= ${from} and ${dateOf(dateBasis)} <= ${to} and ${accountScope(accountId)}
      and (p.environment = ${environment} or a.plaid_item_id is null)
      ${accountId !== undefined ? sql`and t.account_id = ${accountId}` : sql``}`);

  const base = {
    from,
    to,
    accountId,
    includeTransfers: false,
    includePending: true,
    fill: false,
    environment,
    dateBasis,
  };
  const all = summarize(db, { ...base, groupBy: "none" });
  const byCategory = summarize(db, { ...base, groupBy: "category", limit: 6 });

  const expected = expectedTotals(expectedEvents(db, from, to, { accountId, today }));

  return {
    from,
    to,
    currency,
    balance: {
      startMinor,
      endMinor,
      changeMinor: startMinor === null || endMinor === null ? null : endMinor - startMinor,
      projected: to > today,
      accountsCounted: counted.length,
      accountsWithoutBalance: withoutBalance,
      cash: { startMinor: atStart.cashMinor, endMinor: atEnd.cashMinor },
      cardDebt: { startMinor: atStart.cardDebtMinor, endMinor: atEnd.cardDebtMinor },
      projection,
      accounts: counted.map((a) => ({ name: a.name, type: a.type })),
      withoutBalance: candidates
        .filter((a) => a.currentBalanceMinor === null)
        .map((a) => ({ name: a.name, type: a.type })),
    },
    debt: {
      startMinor: owedStart,
      endMinor: owedEnd,
      changeMinor: owedStart === null || owedEnd === null ? null : owedEnd - owedStart,
      accountsCounted: debtAccounts.length,
    },
    // A card payment seen only from the paying side counts only when no card or loan is tracked.
    debtPaidMinor: (totals?.debt ?? 0) + (debtAccountsTracked(db) ? 0 : (totals?.funding ?? 0)),
    moneyInMinor: totals?.in ?? 0,
    moneyOutMinor: totals?.out ?? 0,
    transactionCount: totals?.n ?? 0,
    pendingCount: totals?.pending ?? 0,
    spendingMinor: all.totals.spendingMinor,
    incomeMinor: all.totals.incomeMinor,
    topCategories: byCategory.rows
      .filter((r) => r.spendingMinor > 0)
      .sort((a, b) => b.spendingMinor - a.spendingMinor)
      .slice(0, 5)
      .map((r) => ({ label: r.label, color: r.color, spendingMinor: r.spendingMinor })),
    expected,
    notes: listNotes(db, from, to),
  };
}

export const REPEAT_CHOICES = ["weekly", "biweekly", "monthly"] as const;
export type RepeatChoice = (typeof REPEAT_CHOICES)[number];

/**
 * Makes a transaction the user just entered repeat: the same payment is expected again every week,
 * every two weeks, or every month, on the same account. The occurrence on the entered date is the
 * transaction itself, so it is marked done; later ones show as expected until they happen.
 */
export function repeatFromTransaction(
  db: AppDb,
  t: TransactionDto,
  repeat: RepeatChoice,
  now: string,
): PlannedDto {
  const out = t.amountMinor > 0;
  const weekday = new Date(`${t.date}T00:00:00Z`).getUTCDay();
  const planned = createPlanned(
    db,
    {
      merchant: t.merchant,
      amountMinor: Math.abs(t.amountMinor),
      direction: out ? "out" : "in",
      accountId: t.accountId,
      categoryId: t.category?.id ?? null,
      person: out ? t.recipient : t.sender,
      notes: t.notes,
      startDate: t.date,
      frequency: repeat === "monthly" ? "monthly" : "weekly",
      repeatEvery: repeat === "biweekly" ? 2 : 1,
      ...(repeat === "monthly"
        ? { monthMode: "day" as const, dayOfMonth: Number(t.date.slice(8)) }
        : { weekdays: [weekday] }),
    },
    now,
  );
  setOccurrenceStatus(db, planned.id, t.date, "done", now);
  return getPlanned(db, planned.id);
}
