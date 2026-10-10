import { and, asc, eq, inArray, like, lt } from "drizzle-orm";
import {
  balanceSnapshots,
  fundPrices,
  investmentTransactions,
  securities,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { findKnownFund } from "./investment-funds.js";
import { isTspAccount } from "./tsp.service.js";

/**
 * A TSP account's balance on past days, rebuilt from its activity (imported from the TSP's activity
 * file, or made by the app's contributions) and the fund prices on file: the units held at the end
 * of each priced day, times that day's price. This is what the net worth history shows for the
 * account before the app started recording it.
 *
 * Rebuilt balances are stored at a fixed time of day (the 4 p.m. Eastern close, 20:00 UTC) so they
 * can be told apart from recorded ones and replaced when the history is rebuilt.
 */
const CLOSE = "T20:00:00.000Z";

/**
 * The fund named in an activity row, for rows saved before they were tied to their fund:
 * "Traditional (L 2065)" or "Recurring contribution to C Fund".
 */
function fundInName(name: string): string | null {
  const text = /\(([^)]+)\)\s*$/.exec(name)?.[1] ?? / to (.+)$/.exec(name)?.[1] ?? null;
  return text ? (findKnownFund(text)?.symbol ?? null) : null;
}

export interface HistorySummary {
  days: number;
  from: string | null;
  to: string | null;
}

export function rebuildTspBalanceHistory(
  db: AppDb,
  accountId: number,
  today: string,
): HistorySummary {
  if (!isTspAccount(db, accountId)) return { days: 0, from: null, to: null };
  const activity = db
    .select({
      date: investmentTransactions.date,
      type: investmentTransactions.type,
      name: investmentTransactions.name,
      quantity: investmentTransactions.quantity,
      key: securities.manualKey,
    })
    .from(investmentTransactions)
    .leftJoin(securities, eq(securities.id, investmentTransactions.securityId))
    .where(eq(investmentTransactions.accountId, accountId))
    .orderBy(asc(investmentTransactions.date))
    .all()
    .flatMap((a) => {
      const symbol = a.key?.startsWith("sym:") ? a.key.slice(4) : fundInName(a.name);
      if (!symbol || a.quantity === null) return [];
      const units = a.type === "withdrawal" ? -Math.abs(a.quantity) : a.quantity;
      return [{ date: a.date, symbol, units }];
    });

  db.transaction((tx) => {
    tx.delete(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.accountId, accountId),
          like(balanceSnapshots.observedAt, `%${CLOSE}`),
        ),
      )
      .run();
  });
  if (activity.length === 0) return { days: 0, from: null, to: null };

  const symbols = [...new Set(activity.map((a) => a.symbol))];
  const first = activity[0]!.date;
  const prices = db
    .select({ symbol: fundPrices.symbol, date: fundPrices.date, price: fundPrices.price })
    .from(fundPrices)
    .where(and(inArray(fundPrices.symbol, symbols), lt(fundPrices.date, today)))
    .orderBy(asc(fundPrices.date))
    .all();
  // Every priced day from the first activity until yesterday (today is recorded as it happens).
  const days = [...new Set(prices.map((p) => p.date).filter((d) => d >= first))].sort();

  const units = new Map<string, number>();
  const lastPrice = new Map<string, number>();
  let a = 0;
  let p = 0;
  const rows: Array<{ observedAt: string; valueMinor: number }> = [];
  for (const day of days) {
    while (a < activity.length && activity[a]!.date <= day) {
      const x = activity[a++]!;
      units.set(x.symbol, (units.get(x.symbol) ?? 0) + x.units);
    }
    while (p < prices.length && prices[p]!.date <= day) {
      const x = prices[p++]!;
      lastPrice.set(x.symbol, x.price);
    }
    let value = 0;
    for (const [symbol, n] of units) value += Math.max(0, n) * (lastPrice.get(symbol) ?? 0);
    rows.push({ observedAt: `${day}${CLOSE}`, valueMinor: Math.round(value * 100) });
  }

  db.transaction((tx) => {
    for (const r of rows) {
      tx.insert(balanceSnapshots)
        .values({
          accountId,
          observedAt: r.observedAt,
          currentBalanceMinor: r.valueMinor,
          availableBalanceMinor: null,
          currency: "USD",
        })
        .run();
    }
  });
  return { days: rows.length, from: days[0] ?? null, to: days.at(-1) ?? null };
}

/** Rebuilds the history of every TSP account (after new prices arrive). */
export function rebuildAllTspHistories(db: AppDb, accountIds: number[], today: string): void {
  for (const id of accountIds) rebuildTspBalanceHistory(db, id, today);
}
