import { and, asc, eq, gte, lt, lte } from "drizzle-orm";
import { budgets, categories } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addMonths, firstOfMonth, isRealDate, isRealMonth, lastOfMonth } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { categorySpending, summarize } from "./analytics.service.js";
import { completeMonths, type LeftOutAccount } from "./history-coverage.service.js";

export interface BudgetDto {
  id: number;
  categoryId: number;
  categoryName: string;
  categoryColor: string | null;
  parentId: number | null;
  amountMinor: number;
  rollover: Rollover;
  /** Carried in from last month's budget for the category (negative after overspending). */
  carryInMinor: number;
  /** What there is to spend this month: the amount plus what carried in. */
  availableMinor: number;
  /** Net spending in the category and its subcategories during the month. */
  spentMinor: number;
  /** Available minus spent: what carries into next month when rollover is on. */
  remainingMinor: number;
  /** Whole percent of what is available used; can exceed 100. */
  percentUsed: number;
  overspent: boolean;
  /** A fund saved toward an irregular expense, or null. */
  fund: {
    targetMinor: number;
    targetDate: string;
    /** Months from this one through the target's month (at least 1). */
    monthsLeft: number;
    /** What to set aside each month from now to have it by then. */
    suggestedMinor: number;
    reached: boolean;
  } | null;
  /** Applies to later months too. */
  repeats: boolean;
  /** Comes from an earlier month's repeating cap, with no row of its own for this month. */
  inherited: boolean;
  status: CapStatus;
  /** Where spending would be today at an even pace (null outside the current month). */
  expectedMinor: number | null;
  /** Where the month looks set to end (null outside the current month, or too early to say). */
  projectedMinor: number | null;
  /** The months up to this one, oldest first, when asked for. */
  history?: CapHistoryPoint[];
}

/** `over` is past the cap, `full` exactly at it, `risk` on course to pass it, `ok` otherwise. */
export type CapStatus = "over" | "full" | "risk" | "ok";

export interface CapHistoryPoint {
  month: string;
  spentMinor: number;
  /** The cap that month, or null if there was none. */
  capMinor: number | null;
}

/** A category with spending and no cap, and what a cap might be. */
export interface UncappedCategory {
  categoryId: number;
  label: string;
  color: string | null;
  spentMinor: number;
  /** Average a month over the complete months among the three before. */
  averageMinor: number;
  /** How many months that average is of; 0 when none of the three is complete. */
  averageMonths: number;
}

export const ROLLOVERS = ["off", "all", "leftover"] as const;
export type Rollover = (typeof ROLLOVERS)[number];

export interface BudgetOptions {
  rollover?: Rollover | undefined;
  fundTargetMinor?: number | null | undefined;
  fundTargetDate?: string | null | undefined;
  repeats?: boolean | undefined;
}

export interface BudgetMonth {
  month: string;
  budgets: BudgetDto[];
  totals: { budgetedMinor: number; spentMinor: number; remainingMinor: number };
  /** Spending in the month that no budget covers, for a sense of what is unplanned. */
  unbudgetedSpendingMinor: number;
  /** Categories with spending and no cap, biggest first, when asked for. */
  uncapped?: UncappedCategory[];
  /** Accounts the typical month leaves out because their records stopped. */
  uncappedLeftOut?: LeftOutAccount[];
}

/** Before this many days a month's pace says too little to call anything at risk. */
const MIN_DAYS_FOR_PROJECTION = 5;
const HISTORY_MONTHS = 6;
const UNCAPPED_SHOWN = 12;

const periodOf = (month: string): string => `${month}-01`;

function requireMonth(month: string): void {
  if (!isRealMonth(month))
    throw new AppError(400, "invalid_month", "Month must be written YYYY-MM.");
}

function requireActiveCategory(db: AppDb, id: number): void {
  const category = db
    .select({ active: categories.active })
    .from(categories)
    .where(eq(categories.id, id))
    .get();
  if (!category) throw new AppError(400, "unknown_category", "That category does not exist.");
  if (!category.active) {
    throw new AppError(400, "inactive_category", "That category is archived. Restore it first.");
  }
}

type BudgetRow = typeof budgets.$inferSelect;
type EffectiveRow = BudgetRow & { inherited: boolean };

/**
 * The row that applies to a month given a category's rows up to it, oldest first: the month's own,
 * or the latest one if that repeats and has not been stopped before this month. Pure.
 */
export function effectiveOf(rows: BudgetRow[], month: string): EffectiveRow | null {
  const latest = rows[rows.length - 1];
  if (!latest) return null;
  if (latest.periodStart === periodOf(month)) return { ...latest, inherited: false };
  if (!latest.repeats || (latest.repeatEnd !== null && month > latest.repeatEnd)) return null;
  return { ...latest, periodStart: periodOf(month), inherited: true };
}

function effectiveRow(db: AppDb, categoryId: number, month: string): EffectiveRow | null {
  const rows = db
    .select()
    .from(budgets)
    .where(and(eq(budgets.categoryId, categoryId), lte(budgets.periodStart, periodOf(month))))
    .orderBy(asc(budgets.periodStart))
    .all();
  return effectiveOf(rows, month);
}

/** Every row that applies to a month, whichever month it was set in. */
function effectiveRows(db: AppDb, month: string): EffectiveRow[] {
  const byCategory = new Map<number, BudgetRow[]>();
  for (const row of db
    .select()
    .from(budgets)
    .where(lte(budgets.periodStart, periodOf(month)))
    .orderBy(asc(budgets.periodStart))
    .all()) {
    byCategory.set(row.categoryId, [...(byCategory.get(row.categoryId) ?? []), row]);
  }
  return [...byCategory.values()]
    .map((rows) => effectiveOf(rows, month))
    .filter((r): r is EffectiveRow => r !== null);
}

/**
 * How a cap stands. In the current month, where spending would be at an even pace, and where the
 * month looks set to end: the biggest single day counts once, since rent paid on the 1st does not
 * happen again tomorrow, and only the rest is extended to the end of the month. Pure.
 */
export function capOutlook(input: {
  availableMinor: number;
  spentMinor: number;
  /** The most spent in the category on one day this month. */
  biggestDayMinor: number;
  month: string;
  today: string;
}): { status: CapStatus; expectedMinor: number | null; projectedMinor: number | null } {
  const { availableMinor, spentMinor, biggestDayMinor, month, today } = input;
  const over = spentMinor > availableMinor;
  const full = spentMinor === availableMinor && availableMinor > 0;
  const settled: CapStatus = over ? "over" : full ? "full" : "ok";
  if (today.slice(0, 7) !== month) {
    return { status: settled, expectedMinor: null, projectedMinor: null };
  }
  const day = Number(today.slice(8, 10));
  const days = Number(lastOfMonth(month).slice(8, 10));
  const expectedMinor = Math.round((Math.max(0, availableMinor) * day) / days);
  if (day < MIN_DAYS_FOR_PROJECTION) {
    return { status: settled, expectedMinor, projectedMinor: null };
  }
  const biggest = Math.max(0, Math.min(biggestDayMinor, spentMinor));
  const projectedMinor = Math.round(biggest + ((spentMinor - biggest) * days) / day);
  const status = settled === "ok" && projectedMinor > availableMinor ? "risk" : settled;
  return { status, expectedMinor, projectedMinor };
}

function biggestDay(db: AppDb, categoryId: number, month: string, environment: string): number {
  const { rows } = summarize(db, {
    from: firstOfMonth(month),
    to: lastOfMonth(month),
    groupBy: "day",
    category: categoryId,
    includeTransfers: false,
    includePending: true,
    fill: false,
    environment,
  });
  return rows.reduce((most, r) => Math.max(most, r.spendingMinor), 0);
}

function capHistory(
  db: AppDb,
  categoryId: number,
  month: string,
  environment: string,
): CapHistoryPoint[] {
  return Array.from({ length: HISTORY_MONTHS }, (_, i) => {
    const m = addMonths(month, i - HISTORY_MONTHS + 1);
    return {
      month: m,
      spentMinor: categorySpending(db, categoryId, m, environment),
      capMinor: effectiveRow(db, categoryId, m)?.amountMinor ?? null,
    };
  });
}

/** Spending with no cap, with what the three months before averaged, as a starting point. */
function uncappedCategories(
  db: AppDb,
  month: string,
  environment: string,
  covered: (id: number) => boolean,
): { categories: UncappedCategory[]; leftOut: LeftOutAccount[] } {
  const base = {
    groupBy: "category" as const,
    includeTransfers: false,
    includePending: true,
    fill: false,
    environment,
  };
  const now = summarize(db, { ...base, from: firstOfMonth(month), to: lastOfMonth(month) }).rows;
  const { months: complete, leftOut } = completeMonths(
    db,
    [-3, -2, -1].map((n) => addMonths(month, n)),
    { environment },
  );
  const averageMonths = complete.size;
  const before: typeof now = [];
  for (const m of complete) {
    before.push(...summarize(db, { ...base, from: firstOfMonth(m), to: lastOfMonth(m) }).rows);
  }
  const beforeTotal = (key: string) =>
    before.filter((r) => r.key === key).reduce((n, r) => n + r.spendingMinor, 0);
  const found = new Map<number, UncappedCategory>();
  for (const row of [...now, ...before]) {
    const id = Number(row.key);
    if (id === 0 || covered(id) || found.has(id)) continue;
    found.set(id, {
      categoryId: id,
      label: row.label,
      color: row.color ?? null,
      spentMinor: now.find((r) => r.key === row.key)?.spendingMinor ?? 0,
      averageMinor: averageMonths === 0 ? 0 : Math.round(beforeTotal(row.key) / averageMonths),
      averageMonths,
    });
  }
  const categories = [...found.values()]
    .filter((c) => c.spentMinor > 0 || c.averageMinor > 0)
    .sort((a, b) => Math.max(b.spentMinor, b.averageMinor) - Math.max(a.spentMinor, a.averageMinor))
    .slice(0, UNCAPPED_SHOWN);
  return { categories, leftOut };
}

/** Whole months from one month through another, counting both, at least 1. */
export function monthsThrough(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

/** What last month's budget for the category leaves this month: its end, if it rolls over. */
function carryInto(
  db: AppDb,
  categoryId: number,
  month: string,
  environment: string,
  depth = 0,
): number {
  // Five years back is far more than any carried amount needs.
  if (depth >= 60) return 0;
  const prevMonth = addMonths(month, -1);
  const prev = effectiveRow(db, categoryId, prevMonth);
  if (!prev || prev.rollover === "off") return 0;
  const end =
    prev.amountMinor +
    carryInto(db, categoryId, prevMonth, environment, depth + 1) -
    categorySpending(db, categoryId, prevMonth, environment);
  return prev.rollover === "leftover" ? Math.max(0, end) : end;
}

function toDto(
  db: AppDb,
  row: BudgetRow & { inherited?: boolean },
  environment: string,
  today: string = new Date().toISOString().slice(0, 10),
): BudgetDto {
  const month = row.periodStart.slice(0, 7);
  const category = db.select().from(categories).where(eq(categories.id, row.categoryId)).get()!;
  const spentMinor = categorySpending(db, row.categoryId, month, environment);
  const carryInMinor = carryInto(db, row.categoryId, month, environment);
  const availableMinor = row.amountMinor + carryInMinor;
  let fund: BudgetDto["fund"] = null;
  if (row.fundTargetMinor !== null && row.fundTargetDate !== null) {
    const monthsLeft = monthsThrough(month, row.fundTargetDate.slice(0, 7));
    // What carried in is what the fund has saved so far.
    const toGo = Math.max(0, row.fundTargetMinor - carryInMinor);
    fund = {
      targetMinor: row.fundTargetMinor,
      targetDate: row.fundTargetDate,
      monthsLeft,
      suggestedMinor: Math.ceil(toGo / monthsLeft),
      reached: toGo === 0,
    };
  }
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: category.name,
    categoryColor: category.color,
    parentId: category.parentId,
    amountMinor: row.amountMinor,
    rollover: (ROLLOVERS as readonly string[]).includes(row.rollover)
      ? (row.rollover as Rollover)
      : "off",
    carryInMinor,
    availableMinor,
    spentMinor,
    remainingMinor: availableMinor - spentMinor,
    percentUsed: availableMinor > 0 ? Math.round((spentMinor / availableMinor) * 100) : 0,
    overspent: spentMinor > availableMinor,
    fund,
    repeats: row.repeats,
    inherited: row.inherited ?? false,
    ...capOutlook({
      availableMinor,
      spentMinor,
      biggestDayMinor:
        today.slice(0, 7) === month ? biggestDay(db, row.categoryId, month, environment) : 0,
      month,
      today,
    }),
  };
}

function checkOptions(o: BudgetOptions): void {
  if (o.fundTargetDate != null && !isRealDate(o.fundTargetDate)) {
    throw new AppError(400, "invalid_date", "Enter the fund's date as YYYY-MM-DD.");
  }
  if ((o.fundTargetMinor == null) !== (o.fundTargetDate == null)) {
    throw new AppError(400, "invalid_fund", "A fund needs both an amount and a date.");
  }
}

function byId(db: AppDb, id: number): BudgetRow {
  const row = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!row) throw notFound("That budget");
  return row;
}

/**
 * The caps of one month with what has been spent against each. Archived categories are hidden.
 * `detail` adds each cap's recent months and the categories with no cap.
 */
export function budgetMonth(
  db: AppDb,
  month: string,
  environment: string,
  options: { today?: string | undefined; detail?: boolean } = {},
): BudgetMonth {
  requireMonth(month);
  const names = new Map(
    db
      .select({ id: categories.id, name: categories.name, active: categories.active })
      .from(categories)
      .all()
      .map((c) => [c.id, c] as const),
  );
  const list = effectiveRows(db, month)
    .filter((row) => names.get(row.categoryId)?.active)
    .sort((a, b) => names.get(a.categoryId)!.name.localeCompare(names.get(b.categoryId)!.name))
    .map((row) => ({
      ...toDto(db, row, environment, options.today),
      ...(options.detail ? { history: capHistory(db, row.categoryId, month, environment) } : {}),
    }));
  // A subcategory's spending is already inside its parent's: capped too, it must not count twice.
  const capped = new Set(list.map((b) => b.categoryId));
  const counted = list.filter((b) => b.parentId === null || !capped.has(b.parentId));
  // What there is to spend, carried amounts included, so "left" adds up across the page.
  const budgetedMinor = counted.reduce((sum, b) => sum + b.availableMinor, 0);
  const spentMinor = counted.reduce((sum, b) => sum + b.spentMinor, 0);

  // Spending not covered by any budgeted category (or the subcategories of one).
  const covered = new Set<number>();
  for (const b of list) covered.add(b.categoryId);
  const all = summarize(db, {
    from: firstOfMonth(month),
    to: lastOfMonth(month),
    groupBy: "category",
    includeTransfers: false,
    includePending: true,
    fill: false,
    environment,
  });
  const parentOf = new Map(
    db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories)
      .all()
      .map((c) => [c.id, c.parentId] as const),
  );
  let unbudgeted = 0;
  for (const row of all.rows) {
    const id = Number(row.key);
    const parent = parentOf.get(id) ?? null;
    if (id !== 0 && (covered.has(id) || (parent !== null && covered.has(parent)))) continue;
    unbudgeted += row.spendingMinor;
  }

  const uncappedParts = () => {
    const found = uncappedCategories(db, month, environment, (id) => {
      const parent = parentOf.get(id) ?? null;
      return covered.has(id) || (parent !== null && covered.has(parent));
    });
    return { uncapped: found.categories, uncappedLeftOut: found.leftOut };
  };

  return {
    month,
    budgets: list,
    totals: { budgetedMinor, spentMinor, remainingMinor: budgetedMinor - spentMinor },
    unbudgetedSpendingMinor: unbudgeted,
    ...(options.detail ? uncappedParts() : {}),
  };
}

export function createBudget(
  db: AppDb,
  input: { categoryId: number; month: string; amountMinor: number } & BudgetOptions,
  environment: string,
): BudgetDto {
  requireMonth(input.month);
  checkOptions(input);
  requireActiveCategory(db, input.categoryId);
  const existing = db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(eq(budgets.categoryId, input.categoryId), eq(budgets.periodStart, periodOf(input.month))),
    )
    .get();
  if (existing) {
    throw new AppError(
      409,
      "duplicate_budget",
      "That category already has a budget for this month.",
    );
  }
  const now = new Date().toISOString();
  const created = db
    .insert(budgets)
    .values({
      categoryId: input.categoryId,
      periodStart: periodOf(input.month),
      amountMinor: input.amountMinor,
      rollover: input.rollover ?? "off",
      fundTargetMinor: input.fundTargetMinor ?? null,
      fundTargetDate: input.fundTargetDate ?? null,
      repeats: input.repeats ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDto(db, created, environment);
}

export function updateBudget(
  db: AppDb,
  id: number,
  patch: { amountMinor?: number | undefined; month?: string | undefined } & BudgetOptions,
  environment: string,
): BudgetDto {
  const row = byId(db, id);
  const next = {
    amountMinor: patch.amountMinor ?? row.amountMinor,
    rollover: patch.rollover ?? (row.rollover as Rollover),
    fundTargetMinor:
      patch.fundTargetMinor !== undefined ? patch.fundTargetMinor : row.fundTargetMinor,
    fundTargetDate: patch.fundTargetDate !== undefined ? patch.fundTargetDate : row.fundTargetDate,
    repeats: patch.repeats ?? row.repeats,
  };
  checkOptions(next);
  const now = new Date().toISOString();
  if (patch.month !== undefined) requireMonth(patch.month);
  // Changing a month that only inherits this cap starts from there: earlier months keep theirs.
  if (patch.month !== undefined && periodOf(patch.month) !== row.periodStart) {
    const existing = db
      .select({ id: budgets.id })
      .from(budgets)
      .where(
        and(eq(budgets.categoryId, row.categoryId), eq(budgets.periodStart, periodOf(patch.month))),
      )
      .get();
    if (existing) {
      throw new AppError(409, "duplicate_budget", "That category has its own cap for that month.");
    }
    const created = db
      .insert(budgets)
      .values({
        ...next,
        categoryId: row.categoryId,
        periodStart: periodOf(patch.month),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toDto(db, created, environment);
  }
  db.update(budgets)
    .set({ ...next, repeatEnd: next.repeats ? null : row.repeatEnd, updatedAt: now })
    .where(eq(budgets.id, id))
    .run();
  return toDto(db, byId(db, id), environment);
}

export function deleteBudget(db: AppDb, id: number): void {
  if (!db.select({ id: budgets.id }).from(budgets).where(eq(budgets.id, id)).get()) {
    throw notFound("That budget");
  }
  db.delete(budgets).where(eq(budgets.id, id)).run();
}

/**
 * Takes a cap away from a month on. A cap set for that month alone just goes, and whatever repeating
 * cap it replaced applies again. Anything repeating stops there: earlier months keep their caps.
 */
export function stopBudget(db: AppDb, id: number, month: string): void {
  requireMonth(month);
  const row = byId(db, id);
  const period = periodOf(month);
  if (row.periodStart === period && !row.repeats) {
    db.delete(budgets).where(eq(budgets.id, id)).run();
    return;
  }
  db.transaction((tx) => {
    const fromHere = tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.categoryId, row.categoryId), gte(budgets.periodStart, period)))
      .all();
    for (const later of fromHere) {
      if (later.repeats || later.periodStart === period) {
        tx.delete(budgets).where(eq(budgets.id, later.id)).run();
      }
    }
    const earlier = tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.categoryId, row.categoryId), lt(budgets.periodStart, period)))
      .orderBy(asc(budgets.periodStart))
      .all()
      .at(-1);
    if (earlier?.repeats && (earlier.repeatEnd === null || earlier.repeatEnd >= month)) {
      tx.update(budgets)
        .set({ repeatEnd: addMonths(month, -1), updatedAt: new Date().toISOString() })
        .where(eq(budgets.id, earlier.id))
        .run();
    }
  });
}

/**
 * Copies one month's budgets into another, for categories that do not already have one there
 * (nothing existing is overwritten). Archived categories are skipped.
 */
export function copyBudgets(
  db: AppDb,
  fromMonth: string,
  toMonth: string,
): { created: number; skipped: number } {
  requireMonth(fromMonth);
  requireMonth(toMonth);
  if (fromMonth === toMonth) {
    throw new AppError(400, "invalid_copy", "Choose a different month to copy from.");
  }
  const active = new Map(
    db
      .select({ id: categories.id, active: categories.active })
      .from(categories)
      .all()
      .map((c) => [c.id, c.active] as const),
  );
  const source = effectiveRows(db, fromMonth);
  const already = new Set(effectiveRows(db, toMonth).map((r) => r.categoryId));
  const now = new Date().toISOString();
  let created = 0;
  let skipped = 0;
  db.transaction((tx) => {
    for (const row of source) {
      if (already.has(row.categoryId) || !active.get(row.categoryId)) {
        skipped += 1;
        continue;
      }
      tx.insert(budgets)
        .values({
          categoryId: row.categoryId,
          periodStart: periodOf(toMonth),
          amountMinor: row.amountMinor,
          rollover: row.rollover,
          fundTargetMinor: row.fundTargetMinor,
          fundTargetDate: row.fundTargetDate,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created += 1;
    }
  });
  return { created, skipped };
}
