import { and, asc, eq, inArray, like, lt, not } from "drizzle-orm";
import {
  balanceSnapshots,
  fundPrices,
  investmentTransactions,
  securities,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { findKnownFund } from "./investment-funds.js";
import { heldFunds, isTspAccount } from "./tsp.service.js";

/**
 * A TSP account's balance on past days, rebuilt from what it holds now, its activity (imported from
 * the TSP's activity file, or made by the app's contributions), and the fund prices on file.
 *
 * Units on a past day are worked out backwards from today's holdings: what is held now, less what
 * was bought after that day. Units held before any known activity (entered by hand, or older than
 * the activity file) therefore count on every day, as for other accounts. When the holdings do not
 * include the activity yet (it was imported without updating them), the activity itself is counted.
 *
 * Rebuilt balances are stored at a fixed time of day (the 4 p.m. Eastern close, 20:00 UTC) so they
 * can be told apart from recorded ones and replaced when the history is rebuilt. A day that already
 * has a recorded balance keeps it: a recorded balance is the better figure.
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
  const none = { days: 0, from: null, to: null };
  if (!isTspAccount(db, accountId)) return none;
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

  // Units held before any known activity, per fund: today's holdings less all the activity (or
  // nothing, when the holdings do not include the activity).
  const activityTotal = new Map<string, number>();
  for (const a of activity)
    activityTotal.set(a.symbol, (activityTotal.get(a.symbol) ?? 0) + a.units);
  const units = new Map<string, number>();
  for (const h of heldFunds(db, accountId)) {
    const symbol = findKnownFund(h.symbol)?.symbol ?? h.symbol;
    units.set(symbol, Math.max(0, h.quantity - (activityTotal.get(symbol) ?? 0)));
  }

  // Days with a recorded balance keep it.
  const recorded = new Set(
    db
      .select({ observedAt: balanceSnapshots.observedAt })
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.accountId, accountId),
          not(like(balanceSnapshots.observedAt, `%${CLOSE}`)),
        ),
      )
      .all()
      .map((r) => r.observedAt.slice(0, 10)),
  );

  const rows: Array<{ observedAt: string; valueMinor: number }> = [];
  if (activity.length > 0) {
    const symbols = [...new Set([...activity.map((a) => a.symbol), ...units.keys()])];
    const first = activity[0]!.date;
    const prices = db
      .select({ symbol: fundPrices.symbol, date: fundPrices.date, price: fundPrices.price })
      .from(fundPrices)
      .where(and(inArray(fundPrices.symbol, symbols), lt(fundPrices.date, today)))
      .orderBy(asc(fundPrices.date))
      .all();
    // Every priced day from the first activity until yesterday (today is recorded as it happens).
    const days = [...new Set(prices.map((p) => p.date).filter((d) => d >= first))].sort();

    const lastPrice = new Map<string, number>();
    let a = 0;
    let p = 0;
    for (const day of days) {
      while (a < activity.length && activity[a]!.date <= day) {
        const x = activity[a++]!;
        units.set(x.symbol, (units.get(x.symbol) ?? 0) + x.units);
      }
      while (p < prices.length && prices[p]!.date <= day) {
        const x = prices[p++]!;
        lastPrice.set(x.symbol, x.price);
      }
      if (recorded.has(day)) continue;
      let value = 0;
      for (const [symbol, n] of units) value += Math.max(0, n) * (lastPrice.get(symbol) ?? 0);
      rows.push({ observedAt: `${day}${CLOSE}`, valueMinor: Math.round(value * 100) });
    }
  }

  // Replaced in one step, so a crash never leaves the account without its history.
  db.transaction((tx) => {
    tx.delete(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.accountId, accountId),
          like(balanceSnapshots.observedAt, `%${CLOSE}`),
        ),
      )
      .run();
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
  if (rows.length === 0) return none;
  return {
    days: rows.length,
    from: rows[0]!.observedAt.slice(0, 10),
    to: rows.at(-1)!.observedAt.slice(0, 10),
  };
}

/** Rebuilds the history of every TSP account (after new prices arrive). */
export function rebuildAllTspHistories(db: AppDb, accountIds: number[], today: string): void {
  for (const id of accountIds) rebuildTspBalanceHistory(db, id, today);
}
