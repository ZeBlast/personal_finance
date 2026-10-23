import { asc } from "drizzle-orm";
import { fundPrices } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { findKnownFund } from "./investment-funds.js";
import { heldFunds, isTspAccount } from "./tsp.service.js";
import { AppError } from "../utils/errors.js";

/**
 * The past years of a TSP account's funds, for a retirement range: what the account's current mix
 * of funds would have returned in each calendar year on record. The years come from the fund
 * prices the app has downloaded (the TSP publishes share prices from June 2003), so nothing is
 * typed in by hand. A year counts when the G, F, C, S and I funds all have it.
 *
 * An L fund that did not exist yet in a year (the newer ones started in 2011 or later) takes the
 * return of the nearest L fund that did, and says so.
 */

const CORE = ["TSP-G", "TSP-F", "TSP-C", "TSP-S", "TSP-I"];

/** Each fund's return in each whole calendar year on record, by symbol then year. */
export function yearlyFundReturns(
  prices: Array<{ symbol: string; date: string; price: number }>,
  currentYear: number,
): Map<string, Map<number, number>> {
  // The last price of each year, per fund.
  const yearEnd = new Map<string, Map<number, number>>();
  for (const p of prices) {
    const years = yearEnd.get(p.symbol) ?? new Map<number, number>();
    years.set(Number(p.date.slice(0, 4)), p.price); // prices come oldest first
    yearEnd.set(p.symbol, years);
  }
  const out = new Map<string, Map<number, number>>();
  for (const [symbol, years] of yearEnd) {
    const returns = new Map<number, number>();
    for (const [year, price] of years) {
      const before = years.get(year - 1);
      // Whole years only: this year is not over.
      if (before && before > 0 && year < currentYear) returns.set(year, price / before - 1);
    }
    out.set(symbol, returns);
  }
  return out;
}

/** An L fund's target year (Income counts as the earliest), or null for other funds. */
const lYear = (symbol: string): number | null =>
  symbol === "TSP-LINCOME" ? 2000 : /^TSP-L(\d{4})$/.test(symbol) ? Number(symbol.slice(5)) : null;

export interface FundOutlook {
  /** The account's funds and their share of its value. */
  mix: Array<{ symbol: string; name: string; share: number }>;
  /** What that mix returned in each year on record, oldest first. */
  years: Array<{ year: number; rate: number }>;
  /** L funds that borrowed another L fund's return for years before they existed. */
  standIns: Array<{ symbol: string; by: string; years: number[] }>;
  /** Funds held that have no prices on record (left out of the mix). */
  unpriced: string[];
  /** Fewer than ten years on record: download the price history for a fuller range. */
  needsHistory: boolean;
}

/** The mix's return in each year, with stand-ins for missing L-fund years. Pure. */
export function mixReturns(
  mix: Array<{ symbol: string; share: number }>,
  returns: Map<string, Map<number, number>>,
): Pick<FundOutlook, "years" | "standIns"> {
  const coreYears = [...(returns.get("TSP-G")?.keys() ?? [])].filter((y) =>
    CORE.every((s) => returns.get(s)?.has(y)),
  );
  const lFunds = [...returns.keys()].filter((s) => lYear(s) !== null);
  const stand = new Map<string, { by: string; years: number[] }>();
  const years: FundOutlook["years"] = [];
  for (const year of coreYears.sort((a, b) => a - b)) {
    let rate = 0;
    let complete = true;
    for (const { symbol, share } of mix) {
      let r = returns.get(symbol)?.get(year);
      if (r === undefined && lYear(symbol) !== null) {
        // The nearest L fund (by target year) that had this year.
        const target = lYear(symbol)!;
        const by = lFunds
          .filter((s) => returns.get(s)?.has(year))
          .sort((a, b) => Math.abs(lYear(a)! - target) - Math.abs(lYear(b)! - target))[0];
        if (by) {
          r = returns.get(by)!.get(year)!;
          const note = stand.get(symbol) ?? { by, years: [] };
          note.years.push(year);
          stand.set(symbol, note);
        }
      }
      if (r === undefined) {
        complete = false;
        break;
      }
      rate += share * r;
    }
    if (complete) years.push({ year, rate });
  }
  return {
    years,
    standIns: [...stand.entries()].map(([symbol, s]) => ({ symbol, ...s })),
  };
}

export function tspOutlook(
  db: AppDb,
  accountId: number,
  today = new Date().toISOString().slice(0, 10),
): FundOutlook {
  if (!isTspAccount(db, accountId))
    throw new AppError(404, "not_found", "That TSP account was not found");
  const prices = db
    .select({ symbol: fundPrices.symbol, date: fundPrices.date, price: fundPrices.price })
    .from(fundPrices)
    .orderBy(asc(fundPrices.date))
    .all();
  const returns = yearlyFundReturns(prices, Number(today.slice(0, 4)));

  const held = heldFunds(db, accountId)
    .map((h) => ({ ...h, symbol: findKnownFund(h.symbol)?.symbol ?? h.symbol }))
    .filter((h) => h.valueMinor > 0);
  const priced = held.filter((h) => returns.has(h.symbol));
  const total = priced.reduce((n, h) => n + h.valueMinor, 0);
  const mix = priced.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    share: total > 0 ? h.valueMinor / total : 0,
  }));
  const { years, standIns } = mixReturns(mix, returns);
  return {
    mix,
    years,
    standIns,
    unpriced: held.filter((h) => !returns.has(h.symbol)).map((h) => h.name),
    needsHistory: years.length < 10,
  };
}
