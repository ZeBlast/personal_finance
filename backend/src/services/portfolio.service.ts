import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  balanceSnapshots,
  holdings,
  investmentTransactions,
  securities,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { isRealDate } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts, type AccountSummary } from "./account.service.js";
import { ASSET_CLASSES } from "./investment-funds.js";
import { getSettings } from "./settings.service.js";

/**
 * The investment side of the app, read-only. Everything here treats connected (Plaid) and manual
 * accounts identically: it only looks at accounts of type `investment` and at the shared
 * holdings, snapshot, and transaction tables.
 *
 * Honesty rules: a gain is reported only where the cost is known (and says how much of the
 * portfolio that covers), and the history never shows a value for a date nothing was observed:
 * each account contributes only from its first observation on.
 */

export interface PortfolioAccount {
  id: number;
  name: string;
  officialName: string | null;
  institutionName: string | null;
  source: string;
  isManual: boolean;
  /** For a Thrift Savings Plan kept by hand: "thrift savings plan". */
  subtype: string | null;
  color: string | null;
  connectionStatus: string | null;
  currency: string;
  /** The account's value: its reported balance, or the total of its holdings when it has none. */
  valueMinor: number;
  holdingsValueMinor: number;
  holdingCount: number;
  /** When the value was last updated by a sync or by hand. */
  updatedAt: string | null;
}

export interface AllocationSlice {
  assetClass: string;
  valueMinor: number;
  percent: number;
}

export interface CostBasisSummary {
  /** Value and cost of the holdings whose cost is known. */
  knownValueMinor: number;
  knownCostMinor: number;
  gainMinor: number;
  /** True when every holding's cost is known, so the gain covers the whole portfolio. */
  complete: boolean;
}

export interface PortfolioOverview {
  currency: string;
  totalValueMinor: number;
  holdingsValueMinor: number;
  accounts: PortfolioAccount[];
  allocation: AllocationSlice[];
  costBasis: CostBasisSummary | null;
}

export interface HoldingRow {
  /** Unique per row: account and security, or just the security when positions are combined. */
  key: string;
  securityId: number;
  accountId: number | null;
  accountName: string | null;
  symbol: string | null;
  name: string;
  assetClass: string;
  quantity: number;
  price: number | null;
  valueMinor: number;
  costBasisMinor: number | null;
  gainMinor: number | null;
  /** The vested part of the position, when the source says (a retirement plan, for example). */
  vestedQuantity: number | null;
  vestedValueMinor: number | null;
  /** The date the price is from, when the source gave one separately from `asOf`. */
  priceAsOf: string | null;
  asOf: string;
}

function investmentAccounts(db: AppDb, accountId?: number): AccountSummary[] {
  const environment = getSettings(db).plaidEnvironment;
  const all = listAccounts(db).filter(
    (a) =>
      a.type === "investment" && (a.itemId === null || a.connectionEnvironment === environment),
  );
  if (accountId === undefined) return all;
  const one = all.filter((a) => a.id === accountId);
  if (one.length === 0)
    throw new AppError(404, "not_found", "That investment account was not found");
  return one;
}

type HoldingQueryRow = {
  id: number;
  accountId: number;
  securityId: number;
  symbol: string | null;
  name: string;
  assetClass: string;
  quantity: number;
  price: number | null;
  valueMinor: number;
  costBasisMinor: number | null;
  vestedQuantity: number | null;
  vestedValueMinor: number | null;
  priceAsOf: string | null;
  asOf: string;
};

function holdingRows(db: AppDb, accountIds: number[]): HoldingQueryRow[] {
  if (accountIds.length === 0) return [];
  return db
    .select({
      id: holdings.id,
      accountId: holdings.accountId,
      securityId: holdings.securityId,
      symbol: securities.symbol,
      name: securities.name,
      assetClass: securities.assetClass,
      quantity: holdings.quantity,
      price: holdings.price,
      valueMinor: holdings.valueMinor,
      costBasisMinor: holdings.costBasisMinor,
      vestedQuantity: holdings.vestedQuantity,
      vestedValueMinor: holdings.vestedValueMinor,
      priceAsOf: holdings.priceAsOf,
      asOf: holdings.asOf,
    })
    .from(holdings)
    .innerJoin(securities, eq(holdings.securityId, securities.id))
    .where(inArray(holdings.accountId, accountIds))
    .orderBy(desc(holdings.valueMinor), asc(holdings.id))
    .all();
}

export function portfolioOverview(db: AppDb, accountId?: number): PortfolioOverview {
  const accountList = investmentAccounts(db, accountId);
  const rows = holdingRows(
    db,
    accountList.map((a) => a.id),
  );

  const accounts: PortfolioAccount[] = accountList.map((a) => {
    const mine = rows.filter((r) => r.accountId === a.id);
    const holdingsValueMinor = mine.reduce((sum, r) => sum + r.valueMinor, 0);
    return {
      id: a.id,
      name: a.name,
      officialName: a.officialName,
      institutionName: a.institutionName,
      source: a.source,
      isManual: a.isManual,
      subtype: a.subtype,
      color: a.color,
      connectionStatus: a.connectionStatus,
      currency: a.currency,
      valueMinor: a.currentBalanceMinor ?? holdingsValueMinor,
      holdingsValueMinor,
      holdingCount: mine.length,
      updatedAt: a.lastBalanceUpdateAt,
    };
  });

  const byClass = new Map<string, number>();
  for (const r of rows) byClass.set(r.assetClass, (byClass.get(r.assetClass) ?? 0) + r.valueMinor);
  const holdingsValueMinor = [...byClass.values()].reduce((a, b) => a + b, 0);
  const allocation: AllocationSlice[] = [...byClass.entries()]
    .filter(([, value]) => value > 0)
    .sort(
      (a, b) =>
        b[1] - a[1] || ASSET_CLASSES.indexOf(a[0] as never) - ASSET_CLASSES.indexOf(b[0] as never),
    )
    .map(([assetClass, valueMinor]) => ({
      assetClass,
      valueMinor,
      percent: holdingsValueMinor > 0 ? (valueMinor / holdingsValueMinor) * 100 : 0,
    }));

  const known = rows.filter((r) => r.costBasisMinor !== null);
  const costBasis: CostBasisSummary | null =
    known.length === 0
      ? null
      : {
          knownValueMinor: known.reduce((s, r) => s + r.valueMinor, 0),
          knownCostMinor: known.reduce((s, r) => s + r.costBasisMinor!, 0),
          gainMinor: known.reduce((s, r) => s + r.valueMinor - r.costBasisMinor!, 0),
          complete: known.length === rows.length,
        };

  return {
    currency: accountList[0]?.currency ?? "USD",
    totalValueMinor: accounts.reduce((sum, a) => sum + a.valueMinor, 0),
    holdingsValueMinor,
    accounts,
    allocation,
    costBasis,
  };
}

/**
 * Positions, largest first. With `combine`, the same security held in several accounts becomes
 * one row (its cost is known only if known in every account).
 */
export function portfolioHoldings(
  db: AppDb,
  options: { accountId?: number | undefined; combine?: boolean | undefined },
): HoldingRow[] {
  const accountList = investmentAccounts(db, options.accountId);
  const names = new Map(accountList.map((a) => [a.id, a.name]));
  const rows = holdingRows(
    db,
    accountList.map((a) => a.id),
  );

  const toRow = (r: HoldingQueryRow): HoldingRow => ({
    key: `${r.accountId}:${r.securityId}`,
    securityId: r.securityId,
    accountId: r.accountId,
    accountName: names.get(r.accountId) ?? null,
    symbol: r.symbol,
    name: r.name,
    assetClass: r.assetClass,
    quantity: r.quantity,
    price: r.price,
    valueMinor: r.valueMinor,
    costBasisMinor: r.costBasisMinor,
    gainMinor: r.costBasisMinor === null ? null : r.valueMinor - r.costBasisMinor,
    vestedQuantity: r.vestedQuantity,
    vestedValueMinor: r.vestedValueMinor,
    priceAsOf: r.priceAsOf,
    asOf: r.asOf,
  });
  if (!options.combine) return rows.map(toRow);

  const combined = new Map<number, HoldingRow>();
  for (const r of rows) {
    const existing = combined.get(r.securityId);
    if (!existing) {
      combined.set(r.securityId, {
        ...toRow(r),
        key: `s:${r.securityId}`,
        accountId: null,
        accountName: null,
      });
      continue;
    }
    existing.quantity += r.quantity;
    existing.valueMinor += r.valueMinor;
    existing.costBasisMinor =
      existing.costBasisMinor === null || r.costBasisMinor === null
        ? null
        : existing.costBasisMinor + r.costBasisMinor;
    existing.gainMinor =
      existing.costBasisMinor === null ? null : existing.valueMinor - existing.costBasisMinor;
    existing.vestedQuantity =
      existing.vestedQuantity === null || r.vestedQuantity === null
        ? null
        : existing.vestedQuantity + r.vestedQuantity;
    existing.vestedValueMinor =
      existing.vestedValueMinor === null || r.vestedValueMinor === null
        ? null
        : existing.vestedValueMinor + r.vestedValueMinor;
    if (r.asOf > existing.asOf) existing.asOf = r.asOf;
    existing.price = r.price ?? existing.price;
  }
  return [...combined.values()].sort((a, b) => b.valueMinor - a.valueMinor);
}

export interface HistoryPoint {
  date: string;
  valueMinor: number;
}

export interface PortfolioHistory {
  /**
   * Total value on each day any account was observed. An account counts from its first
   * observation on, at its most recent observed value; nothing is estimated between them.
   */
  total: HistoryPoint[];
  accounts: Array<{
    accountId: number;
    name: string;
    color: string | null;
    points: HistoryPoint[];
  }>;
}

export function portfolioHistory(
  db: AppDb,
  options: { accountId?: number | undefined; from?: string | undefined; to?: string | undefined },
): PortfolioHistory {
  for (const day of [options.from, options.to]) {
    if (day !== undefined && !isRealDate(day)) {
      throw new AppError(400, "invalid_date", "Dates must be real days written as YYYY-MM-DD.");
    }
  }
  const accountList = investmentAccounts(db, options.accountId);
  const ids = accountList.map((a) => a.id);
  if (ids.length === 0) return { total: [], accounts: [] };

  const observations = db
    .select({
      accountId: balanceSnapshots.accountId,
      observedAt: balanceSnapshots.observedAt,
      valueMinor: balanceSnapshots.currentBalanceMinor,
    })
    .from(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, ids))
    .orderBy(asc(balanceSnapshots.observedAt), asc(balanceSnapshots.id))
    .all();

  // The last observation of each account on each day.
  const perDay = new Map<string, Map<number, number>>();
  for (const o of observations) {
    if (o.valueMinor === null) continue;
    const day = o.observedAt.slice(0, 10);
    const accountsThatDay = perDay.get(day) ?? new Map<number, number>();
    accountsThatDay.set(o.accountId, o.valueMinor);
    perDay.set(day, accountsThatDay);
  }

  const inRange = (day: string): boolean =>
    (options.from === undefined || day >= options.from) &&
    (options.to === undefined || day <= options.to);

  const latest = new Map<number, number>();
  const total: HistoryPoint[] = [];
  const perAccount = new Map<number, HistoryPoint[]>(ids.map((id) => [id, []]));
  for (const day of [...perDay.keys()].sort()) {
    for (const [accountId, value] of perDay.get(day)!) {
      latest.set(accountId, value);
      if (inRange(day)) perAccount.get(accountId)!.push({ date: day, valueMinor: value });
    }
    if (inRange(day)) {
      total.push({
        date: day,
        valueMinor: [...latest.values()].reduce((sum, v) => sum + v, 0),
      });
    }
  }
  return {
    total,
    accounts: accountList.map((a) => ({
      accountId: a.id,
      name: a.name,
      color: a.color,
      points: perAccount.get(a.id) ?? [],
    })),
  };
}

export interface InvestmentTransactionRow {
  id: number;
  accountId: number;
  accountName: string | null;
  date: string;
  type: string;
  name: string;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  amountMinor: number;
  feesMinor: number | null;
  currency: string;
  /** The provider's finer label (or the user's), such as "employer match". */
  subtype: string | null;
  transactionDatetime: string | null;
  source: string;
}

export function portfolioTransactions(
  db: AppDb,
  options: { accountId?: number | undefined; limit: number; offset: number },
): { total: number; rows: InvestmentTransactionRow[] } {
  const accountList = investmentAccounts(db, options.accountId);
  const ids = accountList.map((a) => a.id);
  if (ids.length === 0) return { total: 0, rows: [] };
  const names = new Map(accountList.map((a) => [a.id, a.name]));
  const where = inArray(investmentTransactions.accountId, ids);
  const total = db
    .select({ id: investmentTransactions.id })
    .from(investmentTransactions)
    .where(where)
    .all().length;
  const rows = db
    .select({
      id: investmentTransactions.id,
      accountId: investmentTransactions.accountId,
      date: investmentTransactions.date,
      type: investmentTransactions.type,
      name: investmentTransactions.name,
      symbol: securities.symbol,
      quantity: investmentTransactions.quantity,
      price: investmentTransactions.price,
      amountMinor: investmentTransactions.amountMinor,
      feesMinor: investmentTransactions.feesMinor,
      currency: investmentTransactions.currency,
      subtype: investmentTransactions.subtype,
      transactionDatetime: investmentTransactions.transactionDatetime,
      source: investmentTransactions.source,
    })
    .from(investmentTransactions)
    .leftJoin(securities, eq(investmentTransactions.securityId, securities.id))
    .where(where)
    .orderBy(desc(investmentTransactions.date), desc(investmentTransactions.id))
    .limit(options.limit)
    .offset(options.offset)
    .all()
    .map((r) => ({ ...r, accountName: names.get(r.accountId) ?? null }));
  return { total, rows };
}

/** Reads stored JSON back, or null when there is none (or it is damaged). */
function parseStored(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export interface PositionDetail {
  holdingId: number;
  accountId: number;
  accountName: string;
  quantity: number;
  price: number | null;
  valueMinor: number;
  costBasisMinor: number | null;
  vestedQuantity: number | null;
  vestedValueMinor: number | null;
  asOf: string;
  priceAsOf: string | null;
  priceDatetime: string | null;
  /** The complete holding as the provider sent it (tax lots included), when it came from one. */
  raw: unknown;
}

export interface SecurityDetail {
  /** Every stored column about the security, apart from the raw provider object. */
  security: Record<string, unknown>;
  /** The security exactly as the provider sent it, when it came from one. */
  raw: unknown;
  positions: PositionDetail[];
}

/** Everything stored about one security and where it is held. */
export function securityDetail(db: AppDb, securityId: number): SecurityDetail {
  const row = db.select().from(securities).where(eq(securities.id, securityId)).get();
  if (!row) throw new AppError(404, "not_found", "That security was not found");
  const { rawJson, ...security } = row;
  const accountList = investmentAccounts(db);
  const names = new Map(accountList.map((a) => [a.id, a.name]));
  const positions =
    accountList.length === 0
      ? []
      : db
          .select()
          .from(holdings)
          .where(
            and(
              eq(holdings.securityId, securityId),
              inArray(
                holdings.accountId,
                accountList.map((a) => a.id),
              ),
            ),
          )
          .orderBy(desc(holdings.valueMinor))
          .all();
  return {
    security,
    raw: parseStored(rawJson),
    positions: positions.map((p) => ({
      holdingId: p.id,
      accountId: p.accountId,
      accountName: names.get(p.accountId) ?? "",
      quantity: p.quantity,
      price: p.price,
      valueMinor: p.valueMinor,
      costBasisMinor: p.costBasisMinor,
      vestedQuantity: p.vestedQuantity,
      vestedValueMinor: p.vestedValueMinor,
      asOf: p.asOf,
      priceAsOf: p.priceAsOf,
      priceDatetime: p.priceDatetime,
      raw: parseStored(p.rawJson),
    })),
  };
}

export interface InvestmentTransactionDetail extends InvestmentTransactionRow {
  cancelTransactionId: string | null;
  /** The transaction exactly as the provider sent it, when it came from one. */
  raw: unknown;
}

export function investmentTransactionDetail(db: AppDb, id: number): InvestmentTransactionDetail {
  const row = db
    .select({
      accountId: investmentTransactions.accountId,
      rawJson: investmentTransactions.rawJson,
      cancel: investmentTransactions.cancelTransactionId,
    })
    .from(investmentTransactions)
    .where(eq(investmentTransactions.id, id))
    .get();
  if (!row) throw new AppError(404, "not_found", "That transaction was not found");
  // Looking it up through the list keeps the rule that hidden environments stay hidden.
  const found = portfolioTransactions(db, {
    accountId: row.accountId,
    limit: 1_000_000,
    offset: 0,
  }).rows.find((t) => t.id === id);
  if (!found) throw new AppError(404, "not_found", "That transaction was not found");
  return { ...found, cancelTransactionId: row.cancel, raw: parseStored(row.rawJson) };
}
