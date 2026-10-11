import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  balanceSnapshots,
  fundPrices,
  holdingSnapshots,
  holdings,
  investmentTransactions,
  securities,
  tspAllocations,
  tspContributionApplications,
  tspContributions,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { AppError, notFound } from "../utils/errors.js";
import { createManualAccount } from "./investment.service.js";
import { isTspAccount, TSP_SUBTYPE } from "./tsp.service.js";

/**
 * A TSP account as a file, to move it to another copy of the app: the account with its fund
 * allocations, recurring contributions and what they bought, its funds' holdings and their
 * history, its activity, its balance history, and the fund prices behind them. Nothing is
 * downloaded again on the other side. No keys or credentials are involved.
 */

export const TSP_FILE_FORMAT = "personal-finance-tsp";

const security = z.object({
  manualKey: z.string().max(200).nullable(),
  symbol: z.string().max(40).nullable(),
  name: z.string().max(300),
  securityType: z.string().max(60).nullable(),
  assetClass: z.string().max(60),
  currency: z.string().max(10),
});

export const tspFileSchema = z.object({
  format: z.literal(TSP_FILE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().optional(),
  account: z.object({
    name: z.string().trim().min(1).max(80),
    currency: z.string().max(10),
    currentBalanceMinor: z.number().int().nullable(),
    lastBalanceUpdateAt: z.string().nullable(),
  }),
  allocations: z.array(z.object({ symbol: z.string().max(20), percentBps: z.number().int() })),
  contributions: z.array(
    z.object({
      amountMinor: z.number().int(),
      frequency: z.string().max(40),
      startDate: z.string().max(10),
      endDate: z.string().max(10).nullable(),
      dayOfMonth: z.number().int().nullable(),
      secondDayOfMonth: z.number().int().nullable(),
      matchPlan: z.string().max(40).nullable(),
      payMinor: z.number().int().nullable(),
      matchPercent: z.number().nullable(),
      matchUpToPercent: z.number().nullable(),
      autoPercent: z.number().nullable(),
      active: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
      applications: z.array(
        z.object({
          date: z.string().max(10),
          symbol: z.string().max(20),
          priceDate: z.string().max(10),
          price: z.number(),
          units: z.number(),
          amountMinor: z.number().int(),
          employerMinor: z.number().int(),
          appliedAt: z.string(),
        }),
      ),
    }),
  ),
  securities: z.array(security),
  holdings: z.array(
    z.object({
      security: z.number().int().min(0),
      quantity: z.number(),
      price: z.number().nullable(),
      valueMinor: z.number().int(),
      costBasisMinor: z.number().int().nullable(),
      currency: z.string().max(10),
      asOf: z.string(),
      priceAsOf: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
  holdingSnapshots: z.array(
    z.object({
      security: z.number().int().min(0),
      observedAt: z.string(),
      quantity: z.number(),
      valueMinor: z.number().int(),
      costBasisMinor: z.number().int().nullable(),
    }),
  ),
  activity: z.array(
    z.object({
      security: z.number().int().min(0).nullable(),
      importKey: z.string().max(300).nullable(),
      date: z.string().max(10),
      type: z.string().max(40),
      subtype: z.string().max(60).nullable(),
      name: z.string().max(500),
      quantity: z.number().nullable(),
      price: z.number().nullable(),
      amountMinor: z.number().int(),
      feesMinor: z.number().int().nullable(),
      currency: z.string().max(10),
      source: z.string().max(40),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  balances: z.array(
    z.object({
      observedAt: z.string(),
      currentBalanceMinor: z.number().int().nullable(),
      availableBalanceMinor: z.number().int().nullable(),
      currency: z.string().max(10),
    }),
  ),
  fundPrices: z.array(
    z.object({
      symbol: z.string().max(20),
      date: z.string().max(10),
      price: z.number(),
      source: z.string().max(40),
    }),
  ),
});
export type TspFile = z.infer<typeof tspFileSchema>;

export function exportTspAccount(db: AppDb, accountId: number): TspFile {
  if (!isTspAccount(db, accountId)) throw notFound("That TSP account");
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
  const held = db.select().from(holdings).where(eq(holdings.accountId, accountId)).all();
  const snaps = db
    .select()
    .from(holdingSnapshots)
    .where(eq(holdingSnapshots.accountId, accountId))
    .orderBy(asc(holdingSnapshots.observedAt))
    .all();
  const activity = db
    .select()
    .from(investmentTransactions)
    .where(eq(investmentTransactions.accountId, accountId))
    .orderBy(asc(investmentTransactions.date))
    .all();
  const securityIds = [
    ...new Set(
      [...held, ...snaps, ...activity]
        .map((r) => r.securityId)
        .filter((id): id is number => id !== null),
    ),
  ];
  const secs =
    securityIds.length === 0
      ? []
      : db.select().from(securities).where(inArray(securities.id, securityIds)).all();
  const index = new Map(secs.map((s, i) => [s.id, i]));
  const contributions = db
    .select()
    .from(tspContributions)
    .where(eq(tspContributions.accountId, accountId))
    .all();
  const applications =
    contributions.length === 0
      ? []
      : db
          .select()
          .from(tspContributionApplications)
          .where(
            inArray(
              tspContributionApplications.contributionId,
              contributions.map((c) => c.id),
            ),
          )
          .all();
  return {
    format: TSP_FILE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    account: {
      name: account.name,
      currency: account.currency,
      currentBalanceMinor: account.currentBalanceMinor,
      lastBalanceUpdateAt: account.lastBalanceUpdateAt,
    },
    allocations: db
      .select({ symbol: tspAllocations.symbol, percentBps: tspAllocations.percentBps })
      .from(tspAllocations)
      .where(eq(tspAllocations.accountId, accountId))
      .all(),
    contributions: contributions.map((c) => ({
      amountMinor: c.amountMinor,
      frequency: c.frequency,
      startDate: c.startDate,
      endDate: c.endDate,
      dayOfMonth: c.dayOfMonth,
      secondDayOfMonth: c.secondDayOfMonth,
      matchPlan: c.matchPlan,
      payMinor: c.payMinor,
      matchPercent: c.matchPercent,
      matchUpToPercent: c.matchUpToPercent,
      autoPercent: c.autoPercent,
      active: c.active,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      applications: applications
        .filter((a) => a.contributionId === c.id)
        .map((a) => ({
          date: a.date,
          symbol: a.symbol,
          priceDate: a.priceDate,
          price: a.price,
          units: a.units,
          amountMinor: a.amountMinor,
          employerMinor: a.employerMinor,
          appliedAt: a.appliedAt,
        })),
    })),
    securities: secs.map((s) => ({
      manualKey: s.manualKey,
      symbol: s.symbol,
      name: s.name,
      securityType: s.securityType,
      assetClass: s.assetClass,
      currency: s.currency,
    })),
    holdings: held.map((h) => ({
      security: index.get(h.securityId)!,
      quantity: h.quantity,
      price: h.price,
      valueMinor: h.valueMinor,
      costBasisMinor: h.costBasisMinor,
      currency: h.currency,
      asOf: h.asOf,
      priceAsOf: h.priceAsOf,
      updatedAt: h.updatedAt,
    })),
    holdingSnapshots: snaps.map((s) => ({
      security: index.get(s.securityId)!,
      observedAt: s.observedAt,
      quantity: s.quantity,
      valueMinor: s.valueMinor,
      costBasisMinor: s.costBasisMinor,
    })),
    activity: activity.map((t) => ({
      security: t.securityId === null ? null : index.get(t.securityId)!,
      importKey: t.importKey,
      date: t.date,
      type: t.type,
      subtype: t.subtype,
      name: t.name,
      quantity: t.quantity,
      price: t.price,
      amountMinor: t.amountMinor,
      feesMinor: t.feesMinor,
      currency: t.currency,
      source: t.source,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    balances: db
      .select({
        observedAt: balanceSnapshots.observedAt,
        currentBalanceMinor: balanceSnapshots.currentBalanceMinor,
        availableBalanceMinor: balanceSnapshots.availableBalanceMinor,
        currency: balanceSnapshots.currency,
      })
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.accountId, accountId))
      .orderBy(asc(balanceSnapshots.observedAt))
      .all(),
    fundPrices: db
      .select({
        symbol: fundPrices.symbol,
        date: fundPrices.date,
        price: fundPrices.price,
        source: fundPrices.source,
      })
      .from(fundPrices)
      .orderBy(asc(fundPrices.symbol), asc(fundPrices.date))
      .all(),
  };
}

/** Makes a new TSP account from a file, with all its history. */
export function importTspFile(db: AppDb, file: TspFile, now = new Date().toISOString()): number {
  const check = (i: number | null) => {
    if (i !== null && (i < 0 || i >= file.securities.length)) {
      throw new AppError(400, "invalid_file", "The file refers to a fund it does not list.");
    }
  };
  for (const r of [...file.holdings, ...file.holdingSnapshots]) check(r.security);
  for (const r of file.activity) check(r.security);

  return db.transaction((tx) => {
    const t = tx as unknown as AppDb;
    const accountId = createManualAccount(
      t,
      { name: file.account.name, officialName: "Thrift Savings Plan", subtype: TSP_SUBTYPE },
      now,
    );
    // The new account starts with nothing: its balance history comes from the file.
    tx.delete(balanceSnapshots).where(eq(balanceSnapshots.accountId, accountId)).run();
    tx.update(accounts)
      .set({
        currentBalanceMinor: file.account.currentBalanceMinor,
        lastBalanceUpdateAt: file.account.lastBalanceUpdateAt,
        updatedAt: now,
      })
      .where(eq(accounts.id, accountId))
      .run();

    // The same fund here (by its key) is reused; one missing is added.
    const ids = file.securities.map((s) => {
      const existing = s.manualKey
        ? tx
            .select({ id: securities.id })
            .from(securities)
            .where(eq(securities.manualKey, s.manualKey))
            .get()
        : undefined;
      if (existing) return existing.id;
      return tx
        .insert(securities)
        .values({
          manualKey: s.manualKey,
          symbol: s.symbol,
          name: s.name,
          securityType: s.securityType,
          assetClass: s.assetClass,
          currency: s.currency,
          isManual: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: securities.id })
        .get().id;
    });

    for (const a of file.allocations) {
      tx.insert(tspAllocations)
        .values({ accountId, ...a })
        .run();
    }
    for (const { applications, ...c } of file.contributions) {
      const contributionId = tx
        .insert(tspContributions)
        .values({ accountId, ...c })
        .returning({ id: tspContributions.id })
        .get().id;
      for (const a of applications) {
        tx.insert(tspContributionApplications)
          .values({ contributionId, ...a })
          .onConflictDoNothing()
          .run();
      }
    }
    for (const { security, ...h } of file.holdings) {
      tx.insert(holdings)
        .values({ accountId, securityId: ids[security]!, ...h })
        .run();
    }
    for (const { security, ...s } of file.holdingSnapshots) {
      tx.insert(holdingSnapshots)
        .values({ accountId, securityId: ids[security]!, ...s })
        .run();
    }
    for (const { security, ...a } of file.activity) {
      tx.insert(investmentTransactions)
        .values({ accountId, securityId: security === null ? null : ids[security]!, ...a })
        .onConflictDoNothing()
        .run();
    }
    for (const b of file.balances) {
      tx.insert(balanceSnapshots)
        .values({ accountId, ...b })
        .run();
    }
    // Prices are shared by every TSP account; ones already here are kept.
    for (const p of file.fundPrices) {
      tx.insert(fundPrices)
        .values({ ...p, createdAt: now })
        .onConflictDoNothing()
        .run();
    }
    return accountId;
  });
}

/** The TSP accounts, for choosing one to export. */
export function tspAccountsList(db: AppDb) {
  return db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.isManual, true), eq(accounts.subtype, TSP_SUBTYPE)))
    .all();
}
