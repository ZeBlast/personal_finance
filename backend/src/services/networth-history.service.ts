import { asc, inArray } from "drizzle-orm";
import { balanceSnapshots } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { countsInNetWorth } from "./account-scope.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Net worth over time, built ONLY from balances that were actually observed (each sync, each
 * manual update). Nothing is estimated: a day appears in the history only if some balance was
 * recorded that day, and the figure for that day uses each account's most recent observation up
 * to then. Two honesty marks come with every point:
 *   - `accountsObserved` of `accountsTotal`: before an account's first observation it simply is
 *     not part of the total, so early points can be lower than the true figure at the time;
 *   - `gapDays`: how long it had been since the previous point, so quiet stretches are visible.
 */

/** A stretch with no observations at least this long is reported as a gap. */
export const GAP_DAYS = 7;

export interface NetWorthPoint {
  date: string;
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  accountsObserved: number;
  /** Whole days since the previous point, or null for the first. */
  gapDays: number | null;
}

export interface NetWorthGap {
  from: string;
  to: string;
  days: number;
}

export interface NetWorthHistory {
  currency: string;
  /** Accounts that count today. */
  accountsTotal: number;
  points: NetWorthPoint[];
  gaps: NetWorthGap[];
  /** The first day every current account had been observed, or null if that never happened. */
  completeFrom: string | null;
}

const LIABILITY_TYPES = new Set(["credit", "loan"]);

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

export function netWorthHistory(
  db: AppDb,
  options: { from?: string | undefined; to?: string | undefined },
): NetWorthHistory {
  for (const day of [options.from, options.to]) {
    if (day !== undefined && !isRealDate(day)) {
      throw new AppError(400, "invalid_date", "Dates must be real days written as YYYY-MM-DD.");
    }
  }
  const settings = getSettings(db);
  const counted = listAccounts(db).filter(
    (a) =>
      countsInNetWorth(a) &&
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment) &&
      a.currency === settings.currency,
  );
  const typeOf = new Map(counted.map((a) => [a.id, a.type]));
  const empty: NetWorthHistory = {
    currency: settings.currency,
    accountsTotal: counted.length,
    points: [],
    gaps: [],
    completeFrom: null,
  };
  if (counted.length === 0) return empty;

  const observations = db
    .select({
      accountId: balanceSnapshots.accountId,
      observedAt: balanceSnapshots.observedAt,
      valueMinor: balanceSnapshots.currentBalanceMinor,
    })
    .from(balanceSnapshots)
    .where(
      inArray(
        balanceSnapshots.accountId,
        counted.map((a) => a.id),
      ),
    )
    .orderBy(asc(balanceSnapshots.observedAt), asc(balanceSnapshots.id))
    .all();

  // The last observation of each account on each day.
  const perDay = new Map<string, Map<number, number>>();
  for (const o of observations) {
    if (o.valueMinor === null) continue;
    const day = o.observedAt.slice(0, 10);
    const that = perDay.get(day) ?? new Map<number, number>();
    that.set(o.accountId, o.valueMinor);
    perDay.set(day, that);
  }

  const latest = new Map<number, number>();
  const all: NetWorthPoint[] = [];
  let completeFrom: string | null = null;
  for (const day of [...perDay.keys()].sort()) {
    for (const [accountId, value] of perDay.get(day)!) latest.set(accountId, value);
    let assets = 0;
    let liabilities = 0;
    for (const [accountId, value] of latest) {
      if (LIABILITY_TYPES.has(typeOf.get(accountId) ?? "")) liabilities += value;
      else assets += value;
    }
    if (completeFrom === null && latest.size === counted.length) completeFrom = day;
    const previous = all.at(-1);
    all.push({
      date: day,
      assetsMinor: assets,
      liabilitiesMinor: liabilities,
      netWorthMinor: assets - liabilities,
      accountsObserved: latest.size,
      gapDays: previous ? daysBetween(previous.date, day) : null,
    });
  }

  const points = all.filter(
    (p) =>
      (options.from === undefined || p.date >= options.from) &&
      (options.to === undefined || p.date <= options.to),
  );
  const gaps: NetWorthGap[] = [];
  for (const [i, p] of points.entries()) {
    const before = points[i - 1];
    if (before && p.gapDays !== null && p.gapDays >= GAP_DAYS) {
      gaps.push({ from: addDays(before.date, 1), to: addDays(p.date, -1), days: p.gapDays - 1 });
    }
  }
  return { ...empty, points, gaps, completeFrom };
}
