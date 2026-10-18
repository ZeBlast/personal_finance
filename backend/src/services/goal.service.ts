import { asc, eq } from "drizzle-orm";
import { goals } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";

/**
 * Savings goals. Progress is what the goal owns of its linked accounts, plus an amount kept by hand;
 * from the target and its date comes how much a month it takes to get there.
 *
 * Goals share accounts without counting the same money twice: in each account, the goals that set
 * an amount get it first (oldest goal first), and the goals that take "the rest" split what is left
 * evenly.
 */

export interface GoalInput {
  name: string;
  targetMinor: number;
  targetDate?: string | null | undefined;
  savedMinor?: number | undefined;
  accountIds?: number[] | undefined;
  /** A set amount owned in a linked account (cents), by account ID; others share the rest. */
  accountAmounts?: Record<string, number> | undefined;
  color?: string | null | undefined;
}

export interface GoalAccount {
  id: number;
  name: string;
  /** The account's whole balance (what a card or loan owes counts as 0). */
  balanceMinor: number;
  /** What this goal owns of it. */
  countedMinor: number;
  /** The amount set for this goal, or null when it shares the rest. */
  setMinor: number | null;
  /** The set amount is more than the account had left for it. */
  short: boolean;
  /** The other goals that use this account. */
  sharedWith: string[];
}

export interface GoalDto {
  id: number;
  name: string;
  targetMinor: number;
  targetDate: string | null;
  savedMinor: number;
  accountIds: number[];
  accountAmounts: Record<string, number>;
  color: string | null;
  /** The linked accounts as they are now (an account that was removed is left out). */
  accounts: GoalAccount[];
  /** What it owns of the linked accounts, plus the amount kept by hand. */
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
  for (const amount of Object.values(input.accountAmounts ?? {})) {
    if (!Number.isInteger(amount) || amount < 0 || amount > MAX_MINOR) {
      throw new AppError(400, "invalid_amount", "An account's set amount cannot be negative.");
    }
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

function parseIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((n): n is number => Number.isInteger(n));
  } catch {
    // An unreadable list links nothing.
  }
  return [];
}

function parseAmounts(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, number] => Number.isInteger(e[1]) && (e[1] as number) >= 0,
        ),
      );
    }
  } catch {
    // An unreadable map sets nothing.
  }
  return {};
}

export interface Claim {
  goalId: number;
  /** A set amount, or null for a share of the rest. */
  setMinor: number | null;
}

/**
 * Divides one account's balance among the goals that use it: set amounts first, in the order given
 * (oldest goal first), then what is left in even shares (any odd cents to the first). Pure.
 */
export function divideAccount(
  balanceMinor: number,
  claims: Claim[],
): Map<number, { countedMinor: number; short: boolean }> {
  const out = new Map<number, { countedMinor: number; short: boolean }>();
  let left = Math.max(0, balanceMinor);
  for (const c of claims) {
    if (c.setMinor === null) continue;
    const got = Math.min(c.setMinor, left);
    left -= got;
    out.set(c.goalId, { countedMinor: got, short: got < c.setMinor });
  }
  const sharing = claims.filter((c) => c.setMinor === null);
  if (sharing.length > 0) {
    const each = Math.floor(left / sharing.length);
    const odd = left - each * sharing.length;
    sharing.forEach((c, i) =>
      out.set(c.goalId, { countedMinor: each + (i < odd ? 1 : 0), short: false }),
    );
  }
  return out;
}

function toDtos(rows: Array<typeof goals.$inferSelect>, today: string, db: AppDb): GoalDto[] {
  const byId = new Map(listAccounts(db, undefined, true).map((a) => [a.id, a]));
  // What a card or loan owes is not savings.
  const balanceOf = (id: number): number => {
    const a = byId.get(id);
    if (!a || a.type === "credit" || a.type === "loan") return 0;
    return a.currentBalanceMinor ?? 0;
  };
  const parsed = rows.map((row) => ({
    row,
    ids: parseIds(row.accountIds),
    amounts: parseAmounts(row.accountAmounts),
  }));

  // Every account's claims, oldest goal first; then each account is divided once.
  const claims = new Map<number, Claim[]>();
  for (const p of parsed) {
    for (const id of p.ids) {
      const list = claims.get(id) ?? [];
      list.push({ goalId: p.row.id, setMinor: p.amounts[String(id)] ?? null });
      claims.set(id, list);
    }
  }
  const divided = new Map<number, ReturnType<typeof divideAccount>>();
  for (const [accountId, list] of claims) {
    divided.set(accountId, divideAccount(balanceOf(accountId), list));
  }
  const names = new Map(rows.map((r) => [r.id, r.name]));

  return parsed.map(({ row, ids, amounts }) => {
    const accounts: GoalAccount[] = ids
      .map((id) => byId.get(id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined)
      .map((a) => {
        const share = divided.get(a.id)?.get(row.id) ?? { countedMinor: 0, short: false };
        return {
          id: a.id,
          name: a.name,
          balanceMinor: balanceOf(a.id),
          countedMinor: share.countedMinor,
          setMinor: amounts[String(a.id)] ?? null,
          short: share.short,
          sharedWith: (claims.get(a.id) ?? [])
            .filter((c) => c.goalId !== row.id)
            .map((c) => names.get(c.goalId) ?? ""),
        };
      });
    const current = row.savedMinor + accounts.reduce((n, a) => n + a.countedMinor, 0);
    const remaining = Math.max(0, row.targetMinor - current);
    const reached = remaining === 0;
    const overdue = row.targetDate !== null && row.targetDate < today && !reached;
    const monthsLeft =
      row.targetDate === null || row.targetDate < today
        ? null
        : monthsBetween(today, row.targetDate);
    return {
      id: row.id,
      name: row.name,
      targetMinor: row.targetMinor,
      targetDate: row.targetDate,
      savedMinor: row.savedMinor,
      accountIds: ids,
      accountAmounts: amounts,
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
  });
}

const todayOf = (): string => new Date().toISOString().slice(0, 10);

function allRows(db: AppDb) {
  return db.select().from(goals).orderBy(asc(goals.id)).all();
}

export function listGoals(db: AppDb, today = todayOf()): GoalDto[] {
  return toDtos(allRows(db), today, db);
}

/**
 * What goals hold in each account, by account ID: money that is spoken for, so it is not counted as
 * free to spend.
 */
export function goalReservations(db: AppDb): Map<number, number> {
  const out = new Map<number, number>();
  for (const g of listGoals(db)) {
    for (const a of g.accounts) out.set(a.id, (out.get(a.id) ?? 0) + a.countedMinor);
  }
  return out;
}

function goalDto(db: AppDb, id: number, today: string): GoalDto {
  const dto = listGoals(db, today).find((g) => g.id === id);
  if (!dto) throw notFound("That goal");
  return dto;
}

function valuesOf(input: GoalInput) {
  const ids = [...new Set(input.accountIds ?? [])];
  return {
    name: input.name.trim(),
    targetMinor: input.targetMinor,
    targetDate: input.targetDate ?? null,
    savedMinor: input.savedMinor ?? 0,
    accountIds: JSON.stringify(ids),
    // Only amounts for accounts it links.
    accountAmounts: JSON.stringify(
      Object.fromEntries(
        Object.entries(input.accountAmounts ?? {}).filter(([k]) => ids.includes(Number(k))),
      ),
    ),
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
  return goalDto(db, row.id, now.slice(0, 10));
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
  return goalDto(db, row.id, now.slice(0, 10));
}

export function deleteGoal(db: AppDb, id: number): void {
  const res = db.delete(goals).where(eq(goals.id, id)).run();
  if (res.changes === 0) throw notFound("That goal");
}
