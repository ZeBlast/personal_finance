import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  holdings,
  holdingSnapshots,
  investmentTransactions,
  securities,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import type {
  GatewaySecurity,
  HoldingsSnapshot,
  InvestmentTransactionsResult,
} from "../plaid/gateway.js";
import { isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { toMinorUnits } from "../utils/money.js";
import { accountColor, accountIdsByPlaidId } from "./account.service.js";
import { assetClassFor, findKnownFund, isAssetClass, type AssetClass } from "./investment-funds.js";

type Db = Pick<AppDb, "select" | "insert" | "update" | "delete">;

/** One position to store for an account, with money already in minor units. */
export interface PositionInput {
  securityId: number;
  quantity: number;
  price: number | null;
  valueMinor: number;
  costBasisMinor: number | null;
  currency: string;
  asOf: string;
  vestedQuantity?: number | null;
  vestedValueMinor?: number | null;
  priceAsOf?: string | null;
  priceDatetime?: string | null;
  rawJson?: string | null;
}

export const MAX_MANUAL_HOLDINGS = 500;

// ---------------------------------------------------------------- securities

/** The detail columns of a security, from what the provider sent. */
function securityDetail(security: GatewaySecurity) {
  return {
    subtype: security.subtype ?? null,
    isin: security.isin ?? null,
    cusip: security.cusip ?? null,
    sedol: security.sedol ?? null,
    figi: security.figi ?? null,
    cfiCode: security.cfiCode ?? null,
    institutionSecurityId: security.institutionSecurityId ?? null,
    proxySecurityId: security.proxySecurityId ?? null,
    marketIdentifierCode: security.marketIdentifierCode ?? null,
    isCashEquivalent: security.isCashEquivalent ?? null,
    closePrice: security.closePrice ?? null,
    closePriceAsOf: security.closePriceAsOf ?? null,
    sector: security.sector ?? null,
    industry: security.industry ?? null,
    optionContractType: security.option?.contractType ?? null,
    optionExpiration: security.option?.expiration ?? null,
    optionStrike: security.option?.strike ?? null,
    optionUnderlying: security.option?.underlying ?? null,
    fixedYieldRate: security.fixedIncome?.yieldRate ?? null,
    fixedYieldType: security.fixedIncome?.yieldType ?? null,
    fixedMaturityDate: security.fixedIncome?.maturityDate ?? null,
    fixedIssueDate: security.fixedIncome?.issueDate ?? null,
    fixedFaceValue: security.fixedIncome?.faceValue ?? null,
    providerUpdatedAt: security.updatedAt ?? null,
    rawJson: security.raw === undefined ? null : JSON.stringify(security.raw),
  };
}

export function upsertPlaidSecurity(db: Db, security: GatewaySecurity, now: string): number {
  const values = {
    symbol: security.symbol,
    name: security.name,
    securityType: security.type,
    assetClass: assetClassFor(security.type),
    currency: security.currency,
    ...securityDetail(security),
    updatedAt: now,
  };
  const existing = db
    .select({ id: securities.id })
    .from(securities)
    .where(eq(securities.plaidSecurityId, security.securityId))
    .get();
  if (existing) {
    db.update(securities).set(values).where(eq(securities.id, existing.id)).run();
    return existing.id;
  }
  return db
    .insert(securities)
    .values({
      ...values,
      plaidSecurityId: security.securityId,
      isManual: false,
      createdAt: now,
    })
    .returning({ id: securities.id })
    .get().id;
}

/**
 * The descriptive data a security can carry. A connected account fills it from the provider; for an
 * account kept by hand (the Thrift Savings Plan, say) the user can fill in the same things.
 */
export interface SecurityDetailInput {
  securityType?: string | null | undefined;
  subtype?: string | null | undefined;
  isin?: string | null | undefined;
  cusip?: string | null | undefined;
  sedol?: string | null | undefined;
  figi?: string | null | undefined;
  cfiCode?: string | null | undefined;
  sector?: string | null | undefined;
  industry?: string | null | undefined;
  isCashEquivalent?: boolean | null | undefined;
  closePrice?: number | null | undefined;
  closePriceAsOf?: string | null | undefined;
  optionContractType?: string | null | undefined;
  optionExpiration?: string | null | undefined;
  optionStrike?: number | null | undefined;
  optionUnderlying?: string | null | undefined;
  fixedYieldRate?: number | null | undefined;
  fixedYieldType?: string | null | undefined;
  fixedMaturityDate?: string | null | undefined;
  fixedIssueDate?: string | null | undefined;
  fixedFaceValue?: number | null | undefined;
}

/** Keeps only what was actually given: blank text and missing values leave what is stored alone. */
function givenDetail(
  detail: SecurityDetailInput | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

export interface ManualSecurityInput {
  symbol?: string | null | undefined;
  name?: string | null | undefined;
  assetClass?: string | null | undefined;
  currency: string;
  detail?: SecurityDetailInput | undefined;
}

/**
 * Finds or creates a fund the user entered. A fund is identified by its symbol (or by its name
 * when it has none), so entering "TSP-C" twice, or in two accounts, is the same fund. The TSP
 * funds are recognized by their usual names and filled in with a proper name and class.
 */
export function upsertManualSecurity(db: Db, input: ManualSecurityInput, now: string): number {
  const typedSymbol = input.symbol?.trim() || null;
  const typedName = input.name?.trim() || null;
  const known = findKnownFund(typedSymbol) ?? findKnownFund(typedName);
  const symbol = known ? known.symbol : typedSymbol ? typedSymbol.toUpperCase() : null;
  const name = known ? known.name : (typedName ?? symbol);
  if (!name) {
    throw new AppError(400, "invalid_holding", "Each holding needs a fund symbol or a name.");
  }
  if (input.assetClass && !isAssetClass(input.assetClass)) {
    throw new AppError(400, "invalid_asset_class", `"${input.assetClass}" is not an asset class.`);
  }
  const key = symbol ? `sym:${symbol}` : `name:${name.toLowerCase()}`;
  const existing = db
    .select({ id: securities.id, assetClass: securities.assetClass })
    .from(securities)
    .where(eq(securities.manualKey, key))
    .get();
  const requested = input.assetClass as AssetClass | null | undefined;
  const extras = givenDetail(input.detail);
  if (existing) {
    // A class given explicitly wins; otherwise keep what is there.
    const assetClass = requested ?? existing.assetClass;
    db.update(securities)
      .set({ name, assetClass, ...extras, updatedAt: now })
      .where(eq(securities.id, existing.id))
      .run();
    return existing.id;
  }
  return db
    .insert(securities)
    .values({
      manualKey: key,
      symbol,
      name,
      securityType: "fund",
      assetClass: requested ?? known?.assetClass ?? "Other",
      currency: input.currency,
      isManual: true,
      ...extras,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: securities.id })
    .get().id;
}

// ------------------------------------------------------------------- holdings

/**
 * Makes an account's holdings exactly `positions`: updates the ones that exist, adds new ones,
 * removes the rest, and records a snapshot of what was seen.
 */
export function replaceHoldings(
  db: Db,
  accountId: number,
  positions: PositionInput[],
  observedAt: string,
): void {
  const keep = positions.map((p) => p.securityId);
  if (keep.length === 0) {
    db.delete(holdings).where(eq(holdings.accountId, accountId)).run();
    return;
  }
  db.delete(holdings)
    .where(and(eq(holdings.accountId, accountId), notInArray(holdings.securityId, keep)))
    .run();
  for (const p of positions) {
    const values = {
      quantity: p.quantity,
      price: p.price,
      valueMinor: p.valueMinor,
      costBasisMinor: p.costBasisMinor,
      currency: p.currency,
      asOf: p.asOf,
      vestedQuantity: p.vestedQuantity ?? null,
      vestedValueMinor: p.vestedValueMinor ?? null,
      priceAsOf: p.priceAsOf ?? null,
      priceDatetime: p.priceDatetime ?? null,
      rawJson: p.rawJson ?? null,
      updatedAt: observedAt,
    };
    const existing = db
      .select({ id: holdings.id })
      .from(holdings)
      .where(and(eq(holdings.accountId, accountId), eq(holdings.securityId, p.securityId)))
      .get();
    if (existing) db.update(holdings).set(values).where(eq(holdings.id, existing.id)).run();
    else
      db.insert(holdings)
        .values({ accountId, securityId: p.securityId, ...values })
        .run();
    db.insert(holdingSnapshots)
      .values({
        accountId,
        securityId: p.securityId,
        observedAt,
        quantity: p.quantity,
        valueMinor: p.valueMinor,
        costBasisMinor: p.costBasisMinor,
      })
      .run();
  }
}

/** The investment accounts of one connection, by Plaid's account ID. */
function investmentAccountsOf(db: Db, itemRowId: number): Map<string, number> {
  const all = accountIdsByPlaidId(db, itemRowId);
  const ids = [...all.values()];
  if (ids.length === 0) return new Map();
  const investing = new Set(
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(inArray(accounts.id, ids), eq(accounts.type, "investment")))
      .all()
      .map((row) => row.id),
  );
  return new Map([...all].filter(([, id]) => investing.has(id)));
}

/** True when a connection has at least one investment account, i.e. holdings are worth asking for. */
export function hasInvestmentAccounts(db: Db, itemRowId: number): boolean {
  return investmentAccountsOf(db, itemRowId).size > 0;
}

/** Stores the holdings a connection reported. Accounts it reported nothing for end up empty. */
export function applyHoldingsSnapshot(
  db: Db,
  itemRowId: number,
  snapshot: HoldingsSnapshot,
  observedAt: string,
): void {
  const secIds = new Map<string, number>();
  for (const s of snapshot.securities) {
    secIds.set(s.securityId, upsertPlaidSecurity(db, s, observedAt));
  }
  for (const [plaidAccountId, accountId] of investmentAccountsOf(db, itemRowId)) {
    const positions: PositionInput[] = [];
    for (const h of snapshot.holdings.filter((row) => row.accountId === plaidAccountId)) {
      const securityId = secIds.get(h.securityId);
      const valueMinor = toMinorUnits(h.value, h.currency);
      if (securityId === undefined || valueMinor === null) continue;
      positions.push({
        securityId,
        quantity: h.quantity,
        price: h.price,
        valueMinor,
        costBasisMinor: toMinorUnits(h.costBasis, h.currency),
        currency: h.currency,
        asOf: h.asOf ?? observedAt,
        vestedQuantity: h.vestedQuantity ?? null,
        vestedValueMinor: toMinorUnits(h.vestedValue, h.currency),
        priceAsOf: h.priceAsOf ?? null,
        priceDatetime: h.priceDatetime ?? null,
        rawJson: h.raw === undefined ? null : JSON.stringify(h.raw),
      });
    }
    replaceHoldings(db, accountId, positions, observedAt);
  }
}

/** Stores a connection's investment transactions. Running it again changes nothing. */
export function applyInvestmentTransactions(
  db: Db,
  itemRowId: number,
  result: InvestmentTransactionsResult,
  now: string,
): void {
  const accountIds = accountIdsByPlaidId(db, itemRowId);
  const secIds = new Map<string, number>();
  for (const s of result.securities) secIds.set(s.securityId, upsertPlaidSecurity(db, s, now));
  // Plaid sends newest first, so a cancellation usually precedes the purchase it cancels.
  const cancelled = new Set<string>();
  for (const t of result.transactions) {
    if (t.cancelTransactionId) {
      cancelled.add(t.cancelTransactionId);
      cancelled.add(t.transactionId);
    }
  }
  const cancelledIds = [...cancelled];
  for (let i = 0; i < cancelledIds.length; i += 400) {
    db.delete(investmentTransactions)
      .where(
        inArray(
          investmentTransactions.plaidInvestmentTransactionId,
          cancelledIds.slice(i, i + 400),
        ),
      )
      .run();
  }
  for (const t of result.transactions) {
    if (cancelled.has(t.transactionId)) continue;
    const accountId = accountIds.get(t.accountId);
    const amountMinor = toMinorUnits(t.amount, t.currency);
    if (accountId === undefined || amountMinor === null) continue;
    const values = {
      accountId,
      securityId: t.securityId ? (secIds.get(t.securityId) ?? null) : null,
      date: t.date,
      type: t.kind,
      name: t.name,
      quantity: t.quantity,
      price: t.price,
      amountMinor,
      feesMinor: toMinorUnits(t.fees, t.currency),
      currency: t.currency,
      subtype: t.subtype ?? null,
      transactionDatetime: t.datetime ?? null,
      cancelTransactionId: null,
      rawJson: t.raw === undefined ? null : JSON.stringify(t.raw),
      updatedAt: now,
    };
    const existing = db
      .select({ id: investmentTransactions.id })
      .from(investmentTransactions)
      .where(eq(investmentTransactions.plaidInvestmentTransactionId, t.transactionId))
      .get();
    if (existing) {
      db.update(investmentTransactions)
        .set(values)
        .where(eq(investmentTransactions.id, existing.id))
        .run();
    } else {
      db.insert(investmentTransactions)
        .values({
          ...values,
          plaidInvestmentTransactionId: t.transactionId,
          source: "plaid",
          createdAt: now,
        })
        .run();
    }
  }
}

// ------------------------------------------------------------ manual accounts

export interface ManualAccountInput {
  name: string;
  /** What the plan or institution is called, for example "Thrift Savings Plan". */
  officialName?: string | null | undefined;
  subtype?: string | null | undefined;
}

export function createManualAccount(db: AppDb, input: ManualAccountInput, now: string): number {
  const name = input.name.trim();
  if (!name) throw new AppError(400, "invalid_name", "Give the account a name.");
  return db.transaction((tx) => {
    const inserted = tx
      .insert(accounts)
      .values({
        plaidItemId: null,
        plaidAccountId: null,
        name,
        officialName: input.officialName?.trim() || null,
        type: "investment",
        subtype: input.subtype?.trim() || null,
        currency: "USD",
        currentBalanceMinor: 0,
        lastBalanceUpdateAt: now,
        isManual: true,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: accounts.id })
      .get();
    tx.update(accounts)
      .set({ color: accountColor(inserted.id) })
      .where(eq(accounts.id, inserted.id))
      .run();
    return inserted.id;
  });
}

export function requireManualInvestmentAccount(
  db: Pick<AppDb, "select">,
  accountId: number,
): { id: number; currency: string } {
  const account = db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      type: accounts.type,
      isManual: accounts.isManual,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!account) throw notFound("That account");
  if (!account.isManual || account.type !== "investment") {
    throw new AppError(
      409,
      "not_manual",
      "Only accounts you created by hand can be edited here. Connected accounts update when they sync.",
    );
  }
  return { id: account.id, currency: account.currency };
}

/** Removes a manual account and everything recorded under it. Connected accounts cannot be removed. */
export function deleteManualAccount(db: AppDb, accountId: number): void {
  requireManualInvestmentAccount(db, accountId);
  db.delete(accounts).where(eq(accounts.id, accountId)).run();
}

export interface ManualHoldingInput {
  symbol?: string | null | undefined;
  name?: string | null | undefined;
  assetClass?: string | null | undefined;
  quantity: number;
  /** Price per unit as a decimal (fund prices have fractions of a cent). */
  price?: number | null | undefined;
  valueMinor?: number | null | undefined;
  costBasisMinor?: number | null | undefined;
  /** The date the figures are from; defaults to today. */
  asOf?: string | null | undefined;
  /** Of the position, how much has vested (for plans where part of it is not yet fully earned). */
  vestedQuantity?: number | null | undefined;
  vestedValueMinor?: number | null | undefined;
  /** The date the price is from, when it differs from `asOf`. */
  priceAsOf?: string | null | undefined;
  detail?: SecurityDetailInput | undefined;
}

/**
 * Sets what a manual account holds, replacing what was there (so entering the same list again, or
 * importing the same file again, changes nothing). The account's balance becomes the total, and
 * a balance snapshot is recorded so value over time has a point for this update.
 */
export function setManualHoldings(
  db: AppDb,
  accountId: number,
  rows: ManualHoldingInput[],
  now: string,
): { totalMinor: number; count: number } {
  const account = requireManualInvestmentAccount(db, accountId);
  if (rows.length > MAX_MANUAL_HOLDINGS) {
    throw new AppError(400, "too_many_holdings", `At most ${MAX_MANUAL_HOLDINGS} holdings.`);
  }
  const today = now.slice(0, 10);
  return db.transaction((tx) => {
    const positions: PositionInput[] = [];
    const seen = new Set<number>();
    for (const [index, row] of rows.entries()) {
      const label = row.symbol?.trim() || row.name?.trim() || `row ${index + 1}`;
      if (!Number.isFinite(row.quantity) || row.quantity < 0) {
        throw new AppError(400, "invalid_holding", `${label}: the quantity must be 0 or more.`);
      }
      const asOf = row.asOf ?? today;
      if (!isRealDate(asOf)) {
        throw new AppError(400, "invalid_date", `${label}: enter the date as YYYY-MM-DD.`);
      }
      let valueMinor = row.valueMinor ?? null;
      if (valueMinor === null && row.price !== null && row.price !== undefined) {
        valueMinor = toMinorUnits(row.quantity * row.price, account.currency);
      }
      if (valueMinor === null || valueMinor < 0) {
        throw new AppError(
          400,
          "invalid_holding",
          `${label}: give the total value, or a price so it can be worked out.`,
        );
      }
      const securityId = upsertManualSecurity(
        tx,
        {
          symbol: row.symbol,
          name: row.name,
          assetClass: row.assetClass,
          currency: account.currency,
          detail: row.detail,
        },
        now,
      );
      if (
        row.vestedQuantity != null &&
        (row.vestedQuantity < 0 || row.vestedQuantity > row.quantity)
      ) {
        throw new AppError(
          400,
          "invalid_holding",
          `${label}: the vested quantity must be between 0 and the quantity held.`,
        );
      }
      if (
        row.vestedValueMinor != null &&
        (row.vestedValueMinor < 0 || row.vestedValueMinor > valueMinor)
      ) {
        throw new AppError(
          400,
          "invalid_holding",
          `${label}: the vested value must be between 0 and the position's value.`,
        );
      }
      if (row.priceAsOf && !isRealDate(row.priceAsOf)) {
        throw new AppError(400, "invalid_date", `${label}: enter the price date as YYYY-MM-DD.`);
      }
      if (seen.has(securityId)) {
        throw new AppError(400, "duplicate_holding", `${label} is listed more than once.`);
      }
      seen.add(securityId);
      const price =
        row.price !== null && row.price !== undefined
          ? row.price
          : row.quantity > 0
            ? valueMinor / 100 / row.quantity
            : null;
      positions.push({
        securityId,
        quantity: row.quantity,
        price,
        valueMinor,
        costBasisMinor: row.costBasisMinor ?? null,
        currency: account.currency,
        asOf,
        vestedQuantity: row.vestedQuantity ?? null,
        vestedValueMinor: row.vestedValueMinor ?? null,
        priceAsOf: row.priceAsOf ?? null,
      });
    }
    replaceHoldings(tx, accountId, positions, now);
    const totalMinor = positions.reduce((sum, p) => sum + p.valueMinor, 0);
    tx.update(accounts)
      .set({ currentBalanceMinor: totalMinor, lastBalanceUpdateAt: now, updatedAt: now })
      .where(eq(accounts.id, accountId))
      .run();
    tx.insert(balanceSnapshots)
      .values({
        accountId,
        observedAt: now,
        currentBalanceMinor: totalMinor,
        availableBalanceMinor: null,
        currency: account.currency,
      })
      .run();
    return { totalMinor, count: positions.length };
  });
}
