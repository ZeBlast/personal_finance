import { asc, eq } from "drizzle-orm";
import { goals } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";

/**
 * Savings goals. Progress is what the linked accounts hold now, plus an amount kept by hand; from
 * the target and its date comes how much a month it takes to get there.
 */

export interface GoalInput {
  name: string;
  targetMinor: number;
  targetDate?: string | null | undefined;
  savedMinor?: number | undefined;
  accountIds?: number[] | undefined;
  color?: string | null | undefined;
}

export interface GoalDto {
  id: number;
  name: string;
  targetMinor: number;
  targetDate: string | null;
  savedMinor: number;
  accountIds: number[];
  color: string | null;
  /** The linked accounts as they are now (an account that was removed is left out). */
  accounts: Array<{ id: number; name: string; balanceMinor: number }>;
  /** Linked accounts' balances plus the amount kept by hand. */
  currentMinor: number;
  /** 0 to 100 (capped). */
  percent: number;
  remainingMinor: number;
  /** Whole months from today to the target date (at least 1), or null with no date. */
  monthsLeft: number | null;
  /** What to set aside each month to reach it by the date, or null with no date or when reached. */
  perMonthMinor: number | null;
  reached: boolean;
  /** The date has passed and it was not reached. */
  overdue: boolean;
}

const MAX_MINOR = 100_000_000_000;

function check(input: GoalInput): void {
  if (!input.name.trim()) throw new AppError(400, "invalid_name", "Give the goal a name.");
  if (
    !Number.isInteger(input.targetMinor) ||
    input.targetMinor < 1 ||
    input.targetMinor > MAX_MINOR
  ) {
    throw new AppError(400, "invalid_amount", "Enter the target as a positive amount.");
  }
  if (input.targetDate != null && !isRealDate(input.targetDate)) {
    throw new AppError(400, "invalid_date", "Enter the target date as YYYY-MM-DD.");
  }
  const saved = input.savedMinor ?? 0;
  if (!Number.isInteger(saved) || saved < 0 || saved > MAX_MINOR) {
    throw new AppError(400, "invalid_amount", "The amount saved elsewhere cannot be negative.");
  }
}

/** Whole months between two days, rounded up, never below 1. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  if (td > fd) months += 1;
  return Math.max(1, months);
}

function toDto(row: typeof goals.$inferSelect, today: string, db: AppDb): GoalDto {
  let ids: number[] = [];
  try {
    const parsed = JSON.parse(row.accountIds) as unknown;
    if (Array.isArray(parsed)) ids = parsed.filter((n): n is number => Number.isInteger(n));
  } catch {
    // An unreadable list links nothing.
  }
  const byId = new Map(listAccounts(db, undefined, true).map((a) => [a.id, a]));
  const accounts = ids
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined)
    .map((a) => ({
      id: a.id,
      name: a.name,
      // What a card or loan owes is not savings.
      balanceMinor: a.type === "credit" || a.type === "loan" ? 0 : (a.currentBalanceMinor ?? 0),
    }));
  const current = row.savedMinor + accounts.reduce((n, a) => n + a.balanceMinor, 0);
  const remaining = Math.max(0, row.targetMinor - current);
  const reached = remaining === 0;
  const overdue = row.targetDate !== null && row.targetDate < today && !reached;
  const monthsLeft =
    row.targetDate === null || row.targetDate < today ? null : monthsBetween(today, row.targetDate);
  return {
    id: row.id,
    name: row.name,
    targetMinor: row.targetMinor,
    targetDate: row.targetDate,
    savedMinor: row.savedMinor,
    accountIds: ids,
    color: row.color,
    accounts,
    currentMinor: current,
    percent: Math.min(100, Math.round((current / row.targetMinor) * 1000) / 10),
    remainingMinor: remaining,
    monthsLeft,
    perMonthMinor: reached || monthsLeft === null ? null : Math.ceil(remaining / monthsLeft),
    reached,
    overdue,
  };
}

const todayOf = (): string => new Date().toISOString().slice(0, 10);

export function listGoals(db: AppDb, today = todayOf()): GoalDto[] {
  return db
    .select()
    .from(goals)
    .orderBy(asc(goals.id))
    .all()
    .map((g) => toDto(g, today, db));
}

function valuesOf(input: GoalInput) {
  return {
    name: input.name.trim(),
    targetMinor: input.targetMinor,
    targetDate: input.targetDate ?? null,
    savedMinor: input.savedMinor ?? 0,
    accountIds: JSON.stringify([...new Set(input.accountIds ?? [])]),
    color: input.color ?? null,
  };
}

export function createGoal(db: AppDb, input: GoalInput, now = new Date().toISOString()): GoalDto {
  check(input);
  const row = db
    .insert(goals)
    .values({ ...valuesOf(input), createdAt: now, updatedAt: now })
    .returning()
    .get();
  return toDto(row, now.slice(0, 10), db);
}

export function updateGoal(
  db: AppDb,
  id: number,
  input: GoalInput,
  now = new Date().toISOString(),
): GoalDto {
  check(input);
  const row = db
    .update(goals)
    .set({ ...valuesOf(input), updatedAt: now })
    .where(eq(goals.id, id))
    .returning()
    .get();
  if (!row) throw notFound("That goal");
  return toDto(row, now.slice(0, 10), db);
}

export function deleteGoal(db: AppDb, id: number): void {
  const res = db.delete(goals).where(eq(goals.id, id)).run();
  if (res.changes === 0) throw notFound("That goal");
}
