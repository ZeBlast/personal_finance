import { asc, inArray } from "drizzle-orm";
import { balanceSnapshots } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { creditLimitHistoryFor } from "./credit-limit.service.js";
import { getSettings } from "./settings.service.js";

/**
 * How much of its limit each credit card was using, over time. A point exists only on days a
 * balance was recorded AND a limit was known for that day (from the credit limit history), so
 * nothing is estimated. The "all cards" line adds up each card's most recent recorded balance and
 * the limit in effect that day, counting only cards for which both are known.
 */

export interface UtilizationPoint {
  date: string;
  balanceMinor: number;
  limitMinor: number;
  /** Balance as a percent of the limit, to one decimal place. */
  percent: number;
}

export interface CardUtilization {
  accountId: number;
  name: string;
  color: string | null;
  institutionName: string | null;
  points: UtilizationPoint[];
  /** The newest point, or null when no day had both a balance and a limit. */
  latest: UtilizationPoint | null;
}

export interface LimitChange {
  accountId: number;
  name: string;
  date: string;
  fromMinor: number;
  toMinor: number;
  source: string;
}

export interface UtilizationHistory {
  currency: string;
  cards: CardUtilization[];
  total: Array<UtilizationPoint & { cardsIncluded: number }>;
  limitChanges: LimitChange[];
}

const percentOf = (balance: number, limit: number): number =>
  limit > 0 ? Math.round((balance / limit) * 1000) / 10 : 0;

export function creditUtilizationHistory(
  db: AppDb,
  options: { from?: string | undefined; to?: string | undefined },
): UtilizationHistory {
  for (const day of [options.from, options.to]) {
    if (day !== undefined && !isRealDate(day)) {
      throw new AppError(400, "invalid_date", "Dates must be real days written as YYYY-MM-DD.");
    }
  }
  const settings = getSettings(db);
  const cards = listAccounts(db).filter(
    (a) =>
      a.type === "credit" &&
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment) &&
      a.currency === settings.currency,
  );
  const empty: UtilizationHistory = {
    currency: settings.currency,
    cards: [],
    total: [],
    limitChanges: [],
  };
  if (cards.length === 0) return empty;

  const inRange = (day: string): boolean =>
    (options.from === undefined || day >= options.from) &&
    (options.to === undefined || day <= options.to);

  // Each card's limit by effective date, oldest first.
  const limits = new Map(
    cards.map((c) => [
      c.id,
      creditLimitHistoryFor(db, c.id)
        .map((e) => ({ date: e.effectiveDate, limitMinor: e.limitMinor }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    ]),
  );
  const limitOn = (accountId: number, day: string): number | null => {
    let found: number | null = null;
    for (const entry of limits.get(accountId) ?? []) {
      if (entry.date <= day) found = entry.limitMinor;
      else break;
    }
    return found;
  };

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
        cards.map((c) => c.id),
      ),
    )
    .orderBy(asc(balanceSnapshots.observedAt), asc(balanceSnapshots.id))
    .all();

  // The last balance of each card on each day.
  const perDay = new Map<string, Map<number, number>>();
  for (const o of observations) {
    if (o.valueMinor === null) continue;
    const day = o.observedAt.slice(0, 10);
    const that = perDay.get(day) ?? new Map<number, number>();
    that.set(o.accountId, o.valueMinor);
    perDay.set(day, that);
  }

  const perCard = new Map<number, UtilizationPoint[]>(cards.map((c) => [c.id, []]));
  const latestBalance = new Map<number, number>();
  const total: UtilizationHistory["total"] = [];
  for (const day of [...perDay.keys()].sort()) {
    for (const [accountId, balance] of perDay.get(day)!) {
      latestBalance.set(accountId, balance);
      const limit = limitOn(accountId, day);
      if (limit !== null && limit > 0 && inRange(day)) {
        perCard.get(accountId)!.push({
          date: day,
          balanceMinor: balance,
          limitMinor: limit,
          percent: percentOf(balance, limit),
        });
      }
    }
    let balanceSum = 0;
    let limitSum = 0;
    let included = 0;
    for (const [accountId, balance] of latestBalance) {
      const limit = limitOn(accountId, day);
      if (limit === null || limit <= 0) continue;
      balanceSum += balance;
      limitSum += limit;
      included += 1;
    }
    if (included > 0 && inRange(day)) {
      total.push({
        date: day,
        balanceMinor: balanceSum,
        limitMinor: limitSum,
        percent: percentOf(balanceSum, limitSum),
        cardsIncluded: included,
      });
    }
  }

  const limitChanges: LimitChange[] = [];
  for (const card of cards) {
    const entries = creditLimitHistoryFor(db, card.id).sort((a, b) =>
      a.effectiveDate.localeCompare(b.effectiveDate),
    );
    for (const [i, e] of entries.entries()) {
      const before = entries[i - 1];
      if (before && inRange(e.effectiveDate) && before.limitMinor !== e.limitMinor) {
        limitChanges.push({
          accountId: card.id,
          name: card.name,
          date: e.effectiveDate,
          fromMinor: before.limitMinor,
          toMinor: e.limitMinor,
          source: e.source,
        });
      }
    }
  }
  limitChanges.sort((a, b) => b.date.localeCompare(a.date));

  return {
    currency: settings.currency,
    cards: cards.map((c) => {
      const points = perCard.get(c.id) ?? [];
      return {
        accountId: c.id,
        name: c.name,
        color: c.color,
        institutionName: c.institutionName,
        points,
        latest: points.at(-1) ?? null,
      };
    }),
    total,
    limitChanges,
  };
}
