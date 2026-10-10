import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  holdings,
  investmentTransactions,
  securities,
  tspAllocations,
  tspContributionApplications,
  tspContributions,
} from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, isRealDate } from "../utils/dates.js";
import { AppError, notFound } from "../utils/errors.js";
import { occurrences, type RepeatRule } from "../utils/recurrence.js";
import {
  createManualAccount,
  setManualHoldings,
  upsertManualSecurity,
  type ManualHoldingInput,
} from "./investment.service.js";
import { findKnownFund, TSP_FUNDS, type KnownFund } from "./investment-funds.js";
import { latestPrices, priceOnOrBefore } from "./fund-price.service.js";

/**
 * A Thrift Savings Plan account kept by hand, with the things a plan needs that a plain list of
 * holdings does not: how new money is split between funds, a recurring dollar contribution, and the
 * daily fund prices that turn that money into units. Each time a contribution is due it buys units
 * at that day's price, so the balance follows the plan without being retyped.
 */

export const TSP_SUBTYPE = "thrift savings plan";
/** "once" is a one-time contribution on its start date. */
export const FREQUENCIES = ["once", "weekly", "biweekly", "semimonthly", "monthly"] as const;
export type ContributionFrequency = (typeof FREQUENCIES)[number];

/** An amount in cents as dollars: 50000 becomes "$500.00". */
const dollars = (minor: number): string =>
  "$" +
  (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fund units are kept to four decimals, as the TSP reports them. */
const roundUnits = (units: number): number => Math.round(units * 10_000) / 10_000;

export function isTspAccount(db: Pick<AppDb, "select">, accountId: number): boolean {
  const row = db
    .select({ subtype: accounts.subtype, isManual: accounts.isManual, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  return !!row && row.isManual && row.type === "investment" && row.subtype === TSP_SUBTYPE;
}

function requireTspAccount(db: Pick<AppDb, "select">, accountId: number): void {
  const row = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get();
  if (!row) throw notFound("That account");
  if (!isTspAccount(db, accountId)) {
    throw new AppError(
      409,
      "not_a_tsp_account",
      "That is not a Thrift Savings Plan account kept by hand.",
    );
  }
}

// ---- Allocation -----------------------------------------------------------------------------

export interface AllocationInput {
  symbol: string;
  /** A percentage such as 60 or 12.5. */
  percent: number;
}

export interface AllocationDto {
  symbol: string;
  code: string;
  name: string;
  percent: number;
}

function checkAllocations(input: AllocationInput[]): Array<{ fund: KnownFund; bps: number }> {
  if (input.length === 0) {
    throw new AppError(400, "invalid_allocation", "Choose at least one fund.");
  }
  const seen = new Set<string>();
  let total = 0;
  const checked = input.map((a) => {
    const fund = findKnownFund(a.symbol);
    if (!fund) throw new AppError(400, "unknown_fund", `${a.symbol} is not one of the TSP funds.`);
    if (seen.has(fund.symbol)) {
      throw new AppError(400, "invalid_allocation", `${fund.name} is listed more than once.`);
    }
    seen.add(fund.symbol);
    if (
      !Number.isFinite(a.percent) ||
      a.percent <= 0 ||
      a.percent > 100 ||
      Math.abs(a.percent * 100 - Math.round(a.percent * 100)) > 1e-9
    ) {
      throw new AppError(
        400,
        "invalid_allocation",
        `${fund.name}: enter a percentage above 0 and up to 100, with at most two decimals.`,
      );
    }
    const bps = Math.round(a.percent * 100);
    total += bps;
    return { fund, bps };
  });
  if (total !== 10_000) {
    throw new AppError(
      400,
      "invalid_allocation",
      `The percentages add up to ${total / 100}%. They must add up to exactly 100%.`,
    );
  }
  return checked;
}

export function getAllocations(db: Pick<AppDb, "select">, accountId: number): AllocationDto[] {
  return db
    .select({ symbol: tspAllocations.symbol, bps: tspAllocations.percentBps })
    .from(tspAllocations)
    .where(eq(tspAllocations.accountId, accountId))
    .orderBy(desc(tspAllocations.percentBps), asc(tspAllocations.symbol))
    .all()
    .map((r) => {
      const fund = findKnownFund(r.symbol)!;
      return { symbol: r.symbol, code: fund.code, name: fund.name, percent: r.bps / 100 };
    });
}

export function setAllocations(
  db: AppDb,
  accountId: number,
  input: AllocationInput[],
): AllocationDto[] {
  requireTspAccount(db, accountId);
  const checked = checkAllocations(input);
  db.transaction((tx) => {
    tx.delete(tspAllocations).where(eq(tspAllocations.accountId, accountId)).run();
    for (const { fund, bps } of checked) {
      tx.insert(tspAllocations).values({ accountId, symbol: fund.symbol, percentBps: bps }).run();
    }
  });
  return getAllocations(db, accountId);
}

/** Creates the account, with the split of future contributions chosen up front. */
export function createTspAccount(
  db: AppDb,
  input: { name: string; allocations: AllocationInput[] },
  now: string,
): number {
  const checked = checkAllocations(input.allocations);
  return db.transaction((tx) => {
    const id = createManualAccount(
      tx as unknown as AppDb,
      { name: input.name, officialName: "Thrift Savings Plan", subtype: TSP_SUBTYPE },
      now,
    );
    for (const { fund, bps } of checked) {
      tx.insert(tspAllocations)
        .values({ accountId: id, symbol: fund.symbol, percentBps: bps })
        .run();
    }
    return id;
  });
}

// ---- Recurring contributions ----------------------------------------------------------------

export interface ContributionInput {
  amountMinor: number;
  frequency: ContributionFrequency;
  startDate: string;
  endDate?: string | null | undefined;
  /** Monthly and semimonthly: 1 to 31, or -1 for the last day. Defaults to the start date's day. */
  dayOfMonth?: number | null | undefined;
  /** Semimonthly: the second day (defaults to 15 days after the first, within the month). */
  secondDayOfMonth?: number | null | undefined;
  /** Employer money on top (see MATCH_PLANS); needs `payMinor`. */
  matchPlan?: MatchPlan | null | undefined;
  payMinor?: number | null | undefined;
  matchPercent?: number | null | undefined;
  matchUpToPercent?: number | null | undefined;
  autoPercent?: number | null | undefined;
}

/**
 * `fers`: the federal agency puts in 1% of pay automatically, plus dollar for dollar on the first
 * 3% of pay you put in and 50 cents on the dollar on the next 2% (5% in all at 5% from you).
 * `custom`: an employer that matches `matchPercent`% of what you put in, up to
 * `matchUpToPercent`% of pay, plus `autoPercent`% of pay whatever you put in.
 */
export const MATCH_PLANS = ["fers", "custom"] as const;
export type MatchPlan = (typeof MATCH_PLANS)[number];

/** What the employer adds on one contribution day, in cents. */
export function employerAmount(
  c: Pick<
    ContributionRow,
    "amountMinor" | "matchPlan" | "payMinor" | "matchPercent" | "matchUpToPercent" | "autoPercent"
  >,
): number {
  const pay = c.payMinor ?? 0;
  if (!c.matchPlan || pay <= 0) return 0;
  const yours = Math.max(0, c.amountMinor);
  if (c.matchPlan === "fers") {
    const first = Math.min(yours, pay * 0.03);
    const next = Math.min(Math.max(0, yours - pay * 0.03), pay * 0.02);
    return Math.round(pay * 0.01 + first + next * 0.5);
  }
  const matched = Math.min(
    (yours * (c.matchPercent ?? 0)) / 100,
    (pay * (c.matchUpToPercent ?? 0)) / 100,
  );
  return Math.round(matched + (pay * (c.autoPercent ?? 0)) / 100);
}

type ContributionRow = typeof tspContributions.$inferSelect;

const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

function rulesOf(
  c: Pick<
    ContributionRow,
    "frequency" | "startDate" | "endDate" | "dayOfMonth" | "secondDayOfMonth"
  >,
): RepeatRule[] {
  const base = {
    startDate: c.startDate,
    endDate: c.endDate,
    maxCount: null,
    nthWeek: null,
  };
  if (c.frequency === "weekly" || c.frequency === "biweekly") {
    return [
      {
        ...base,
        frequency: "weekly",
        repeatEvery: c.frequency === "biweekly" ? 2 : 1,
        weekdays: [weekdayOf(c.startDate)],
        monthMode: null,
        dayOfMonth: null,
      },
    ];
  }
  const startDay = Number(c.startDate.slice(8));
  const first = c.dayOfMonth ?? startDay;
  const days =
    c.frequency === "semimonthly"
      ? [first, c.secondDayOfMonth ?? Math.min(first + 14, 28)]
      : [first];
  return days.map((day) => ({
    ...base,
    frequency: "monthly" as const,
    repeatEvery: 1,
    weekdays: [],
    monthMode: "day" as const,
    dayOfMonth: day,
  }));
}

/** The days a contribution is due, in order. */
export function dueDates(
  c: Pick<
    ContributionRow,
    "frequency" | "startDate" | "endDate" | "dayOfMonth" | "secondDayOfMonth"
  >,
  from: string,
  to: string,
): string[] {
  if (c.frequency === "once") return c.startDate >= from && c.startDate <= to ? [c.startDate] : [];
  const all = rulesOf(c).flatMap((rule) => occurrences(rule, from, to));
  return [...new Set(all)].sort();
}

function describeContribution(c: ContributionRow): string {
  const amount = dollars(c.amountMinor);
  switch (c.frequency) {
    case "once":
      return `${amount} once, on ${c.startDate}`;
    case "weekly":
      return `${amount} every week`;
    case "biweekly":
      return `${amount} every 2 weeks`;
    case "monthly":
      return `${amount} a month on the ${ordinal(c.dayOfMonth ?? Number(c.startDate.slice(8)))}`;
    default:
      return `${amount} twice a month, on the ${ordinal(c.dayOfMonth ?? Number(c.startDate.slice(8)))} and the ${ordinal(c.secondDayOfMonth ?? Math.min((c.dayOfMonth ?? Number(c.startDate.slice(8))) + 14, 28))}`;
  }
}

function ordinal(n: number): string {
  if (n === -1) return "last day";
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${suffix}`;
}

function checkContribution(input: ContributionInput): void {
  if (
    !Number.isInteger(input.amountMinor) ||
    input.amountMinor < 1 ||
    input.amountMinor > 100_000_000
  ) {
    throw new AppError(
      400,
      "invalid_amount",
      "Enter the contribution as a positive dollar amount.",
    );
  }
  if (!FREQUENCIES.includes(input.frequency)) {
    throw new AppError(
      400,
      "invalid_frequency",
      "Choose one time, weekly, every 2 weeks, twice a month, or monthly.",
    );
  }
  if (!isRealDate(input.startDate)) {
    throw new AppError(400, "invalid_date", "Enter the first date as YYYY-MM-DD.");
  }
  if (input.endDate != null) {
    if (!isRealDate(input.endDate)) {
      throw new AppError(400, "invalid_date", "Enter the end date as YYYY-MM-DD.");
    }
    if (input.endDate < input.startDate) {
      throw new AppError(400, "invalid_date", "The end date is before the start date.");
    }
  }
  if (input.matchPlan != null) {
    if (!MATCH_PLANS.includes(input.matchPlan)) {
      throw new AppError(
        400,
        "invalid_match",
        "Choose the federal (FERS) match, your own, or none.",
      );
    }
    if (input.payMinor == null || !Number.isInteger(input.payMinor) || input.payMinor < 1) {
      throw new AppError(
        400,
        "invalid_pay",
        "Enter your gross pay for each contribution, which the match is worked out from.",
      );
    }
    for (const p of [input.matchPercent, input.matchUpToPercent, input.autoPercent]) {
      if (p != null && (!Number.isFinite(p) || p < 0 || p > 200)) {
        throw new AppError(400, "invalid_match", "Match percentages are 0 to 200.");
      }
    }
  }
  for (const day of [input.dayOfMonth, input.secondDayOfMonth]) {
    if (day != null && day !== -1 && (!Number.isInteger(day) || day < 1 || day > 31)) {
      throw new AppError(400, "invalid_day", "A day of the month is 1 to 31, or the last day.");
    }
  }
}

function columnsOf(input: ContributionInput) {
  const monthly = input.frequency === "monthly" || input.frequency === "semimonthly";
  return {
    amountMinor: input.amountMinor,
    frequency: input.frequency,
    startDate: input.startDate,
    // A one-time contribution ends the day it is made.
    endDate: input.frequency === "once" ? input.startDate : (input.endDate ?? null),
    dayOfMonth: monthly ? (input.dayOfMonth ?? Number(input.startDate.slice(8))) : null,
    secondDayOfMonth:
      input.frequency === "semimonthly"
        ? (input.secondDayOfMonth ??
          Math.min((input.dayOfMonth ?? Number(input.startDate.slice(8))) + 14, 28))
        : null,
    matchPlan: input.matchPlan ?? null,
    payMinor: input.matchPlan ? (input.payMinor ?? null) : null,
    matchPercent: input.matchPlan === "custom" ? (input.matchPercent ?? 0) : null,
    matchUpToPercent: input.matchPlan === "custom" ? (input.matchUpToPercent ?? 0) : null,
    autoPercent: input.matchPlan === "custom" ? (input.autoPercent ?? 0) : null,
  };
}

export interface ContributionDto {
  id: number;
  amountMinor: number;
  frequency: ContributionFrequency;
  startDate: string;
  endDate: string | null;
  dayOfMonth: number | null;
  secondDayOfMonth: number | null;
  matchPlan: MatchPlan | null;
  payMinor: number | null;
  matchPercent: number | null;
  matchUpToPercent: number | null;
  autoPercent: number | null;
  /** What the employer adds each time (0 for none). */
  employerMinor: number;
  active: boolean;
  /** In words, such as "$500.00 every 2 weeks". */
  description: string;
  /** The next day it is due, or null once it has ended. */
  nextDate: string | null;
}

function contributionDto(c: ContributionRow, today: string): ContributionDto {
  return {
    id: c.id,
    amountMinor: c.amountMinor,
    frequency: c.frequency as ContributionFrequency,
    startDate: c.startDate,
    endDate: c.endDate,
    dayOfMonth: c.dayOfMonth,
    secondDayOfMonth: c.secondDayOfMonth,
    matchPlan: c.matchPlan === "fers" || c.matchPlan === "custom" ? c.matchPlan : null,
    payMinor: c.payMinor,
    matchPercent: c.matchPercent,
    matchUpToPercent: c.matchUpToPercent,
    autoPercent: c.autoPercent,
    employerMinor: employerAmount(c),
    active: c.active,
    description:
      describeContribution(c) +
      (employerAmount(c) > 0 ? `, plus ${dollars(employerAmount(c))} from your employer` : ""),
    nextDate: c.active ? (dueDates(c, addDays(today, 1), addDays(today, 400))[0] ?? null) : null,
  };
}

export function createContribution(
  db: AppDb,
  accountId: number,
  input: ContributionInput,
  now: string,
): ContributionDto {
  requireTspAccount(db, accountId);
  checkContribution(input);
  const row = db
    .insert(tspContributions)
    .values({ accountId, ...columnsOf(input), active: true, createdAt: now, updatedAt: now })
    .returning()
    .get();
  return contributionDto(row, now.slice(0, 10));
}

function requireContribution(db: AppDb, id: number): ContributionRow {
  const row = db.select().from(tspContributions).where(eq(tspContributions.id, id)).get();
  if (!row) throw notFound("That contribution");
  return row;
}

export function updateContribution(
  db: AppDb,
  id: number,
  input: ContributionInput & { active?: boolean | undefined },
  now: string,
): ContributionDto {
  const existing = requireContribution(db, id);
  checkContribution(input);
  const row = db
    .update(tspContributions)
    .set({ ...columnsOf(input), active: input.active ?? existing.active, updatedAt: now })
    .where(eq(tspContributions.id, id))
    .returning()
    .get();
  return contributionDto(row, now.slice(0, 10));
}

/** Stops it, and removes it. What it already bought stays in the holdings and the activity. */
export function deleteContribution(db: AppDb, id: number): void {
  requireContribution(db, id);
  db.delete(tspContributions).where(eq(tspContributions.id, id)).run();
}

// ---- Turning contributions into units -------------------------------------------------------

export interface ApplyResult {
  /** Contribution days turned into units now. */
  applied: number;
  /** Days that are due but have no price yet for every fund in the split, with the funds missing. */
  waiting: Array<{ contributionId: number; date: string; missing: string[] }>;
}

interface HeldFund {
  symbol: string;
  name: string;
  assetClass: string;
  quantity: number;
  costBasisMinor: number | null;
  price: number | null;
  valueMinor: number;
}

export function heldFunds(db: Pick<AppDb, "select">, accountId: number): HeldFund[] {
  return db
    .select({
      symbol: securities.symbol,
      name: securities.name,
      assetClass: securities.assetClass,
      quantity: holdings.quantity,
      costBasisMinor: holdings.costBasisMinor,
      price: holdings.price,
      valueMinor: holdings.valueMinor,
    })
    .from(holdings)
    .innerJoin(securities, eq(securities.id, holdings.securityId))
    .where(eq(holdings.accountId, accountId))
    .all()
    .map((r) => ({ ...r, symbol: r.symbol ?? r.name }));
}

/** Splits an amount by the allocation, to the cent, the leftover cents going to the biggest share. */
export function splitAmount(
  amountMinor: number,
  shares: Array<{ symbol: string; bps: number }>,
): Map<string, number> {
  const split = new Map<string, number>();
  let assigned = 0;
  for (const s of shares) {
    const part = Math.floor((amountMinor * s.bps) / 10_000);
    split.set(s.symbol, part);
    assigned += part;
  }
  const biggest = [...shares].sort((a, b) => b.bps - a.bps)[0]!;
  split.set(biggest.symbol, split.get(biggest.symbol)! + (amountMinor - assigned));
  return split;
}

/** Writes the account's holdings from a list, at the newest known price of each fund. */
export function writeHoldings(
  db: AppDb,
  accountId: number,
  funds: Array<{
    symbol: string;
    name: string;
    assetClass: string;
    quantity: number;
    costBasisMinor: number | null;
    fallbackPrice: number | null;
    fallbackValueMinor: number;
  }>,
  today: string,
  now: string,
): void {
  const prices = latestPrices(
    db,
    funds.map((f) => f.symbol),
  );
  const rows: ManualHoldingInput[] = funds
    .filter((f) => f.quantity > 0)
    .map((f) => {
      const latest = prices.get(f.symbol);
      return {
        symbol: f.symbol,
        name: f.name,
        assetClass: f.assetClass,
        quantity: f.quantity,
        ...(latest
          ? { price: latest.price, priceAsOf: latest.date }
          : f.fallbackPrice !== null
            ? { price: f.fallbackPrice }
            : { valueMinor: f.fallbackValueMinor }),
        costBasisMinor: f.costBasisMinor,
        asOf: today,
      };
    });
  setManualHoldings(db, accountId, rows, now);
}

export function tspAccountIds(db: Pick<AppDb, "select">, only?: number): number[] {
  const ids = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.subtype, TSP_SUBTYPE),
        eq(accounts.isManual, true),
        eq(accounts.type, "investment"),
      ),
    )
    .all()
    .map((r) => r.id);
  return only === undefined ? ids : ids.filter((id) => id === only);
}

/**
 * Turns every contribution that has come due into fund units at that day's price (the price of the
 * day, or of the last business day before it), adds the units to the holdings, and records each as
 * activity. A day that is already done is never done again, and a day without prices yet waits.
 */
export function applyDueContributions(
  db: AppDb,
  options: {
    accountId?: number | undefined;
    today?: string | undefined;
    now?: string | undefined;
  } = {},
): ApplyResult {
  const now = options.now ?? new Date().toISOString();
  const today = options.today ?? now.slice(0, 10);
  const result: ApplyResult = { applied: 0, waiting: [] };

  for (const accountId of tspAccountIds(db, options.accountId)) {
    const shares = getAllocations(db, accountId).map((a) => ({
      symbol: a.symbol,
      bps: Math.round(a.percent * 100),
    }));
    if (shares.length === 0) continue;
    const contributions = db
      .select()
      .from(tspContributions)
      .where(and(eq(tspContributions.accountId, accountId), eq(tspContributions.active, true)))
      .all();

    // What each fund gained, for the holdings, across every day applied in this pass.
    const gained = new Map<string, { units: number; amountMinor: number }>();
    for (const c of contributions) {
      const done = new Set(
        db
          .select({ date: tspContributionApplications.date })
          .from(tspContributionApplications)
          .where(eq(tspContributionApplications.contributionId, c.id))
          .all()
          .map((r) => r.date),
      );
      for (const date of dueDates(c, c.startDate, today)) {
        if (done.has(date)) continue;
        const priced = shares.map((s) => ({ ...s, price: priceOnOrBefore(db, s.symbol, date) }));
        const missing = priced.filter((p) => p.price === null).map((p) => p.symbol);
        if (missing.length > 0) {
          result.waiting.push({ contributionId: c.id, date, missing });
          continue;
        }
        const employer = employerAmount(c);
        const mine = splitAmount(c.amountMinor, shares);
        const theirs = employer > 0 ? splitAmount(employer, shares) : new Map<string, number>();
        db.transaction((tx) => {
          for (const p of priced) {
            const own = mine.get(p.symbol) ?? 0;
            const match = theirs.get(p.symbol) ?? 0;
            if (own + match <= 0) continue;
            const price = p.price!;
            const ownUnits = roundUnits(own / 100 / price.price);
            const matchUnits = roundUnits(match / 100 / price.price);
            tx.insert(tspContributionApplications)
              .values({
                contributionId: c.id,
                date,
                symbol: p.symbol,
                priceDate: price.date,
                price: price.price,
                units: roundUnits(ownUnits + matchUnits),
                amountMinor: own + match,
                employerMinor: match,
                appliedAt: now,
              })
              .run();
            const securityId = upsertManualSecurity(tx, { symbol: p.symbol, currency: "USD" }, now);
            const fund = findKnownFund(p.symbol)!;
            const record = (
              key: string,
              name: string,
              subtype: string,
              units: number,
              amount: number,
            ) =>
              tx
                .insert(investmentTransactions)
                .values({
                  accountId,
                  securityId,
                  importKey: key,
                  date,
                  type: "contribution",
                  name,
                  quantity: units,
                  price: price.price,
                  amountMinor: -amount, // money coming in is stored negative
                  feesMinor: null,
                  currency: "USD",
                  subtype,
                  source: "manual",
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoNothing({ target: investmentTransactions.importKey })
                .run();
            if (own > 0) {
              record(
                `tsp:${c.id}:${date}:${p.symbol}`,
                `${c.frequency === "once" ? "One-time" : "Recurring"} contribution to ${fund.name}`,
                "recurring contribution",
                ownUnits,
                own,
              );
            }
            if (match > 0) {
              record(
                `tsp:${c.id}:${date}:${p.symbol}:employer`,
                `Employer contribution to ${fund.name}`,
                "employer contribution",
                matchUnits,
                match,
              );
            }
            const g = gained.get(p.symbol) ?? { units: 0, amountMinor: 0 };
            g.units += ownUnits + matchUnits;
            g.amountMinor += own + match;
            gained.set(p.symbol, g);
          }
        });
        result.applied += 1;
      }
    }

    if (gained.size > 0) {
      const held = new Map(heldFunds(db, accountId).map((h) => [h.symbol, h]));
      const funds = new Map<string, Parameters<typeof writeHoldings>[2][number]>();
      for (const h of held.values()) {
        funds.set(h.symbol, {
          symbol: h.symbol,
          name: h.name,
          assetClass: h.assetClass,
          quantity: h.quantity,
          costBasisMinor: h.costBasisMinor,
          fallbackPrice: h.price,
          fallbackValueMinor: h.valueMinor,
        });
      }
      for (const [symbol, g] of gained) {
        const fund = findKnownFund(symbol)!;
        const before = funds.get(symbol);
        funds.set(symbol, {
          symbol,
          name: fund.name,
          assetClass: fund.assetClass,
          quantity: roundUnits((before?.quantity ?? 0) + g.units),
          costBasisMinor: (before?.costBasisMinor ?? 0) + g.amountMinor,
          fallbackPrice: before?.fallbackPrice ?? null,
          fallbackValueMinor: before?.fallbackValueMinor ?? 0,
        });
      }
      writeHoldings(db, accountId, [...funds.values()], today, now);
    }
  }
  return result;
}

/**
 * Values each TSP account's units at the newest price of each fund, so the balance follows the
 * market between contributions. Does nothing for an account whose value has not changed.
 */
export function refreshTspValues(
  db: AppDb,
  options: {
    accountId?: number | undefined;
    today?: string | undefined;
    now?: string | undefined;
  } = {},
): number {
  const now = options.now ?? new Date().toISOString();
  const today = options.today ?? now.slice(0, 10);
  let changed = 0;
  for (const accountId of tspAccountIds(db, options.accountId)) {
    const held = heldFunds(db, accountId);
    if (held.length === 0) continue;
    const prices = latestPrices(
      db,
      held.map((h) => h.symbol),
    );
    const moved = held.some((h) => {
      const latest = prices.get(h.symbol);
      return latest !== undefined && Math.round(h.quantity * latest.price * 100) !== h.valueMinor;
    });
    if (!moved) continue;
    writeHoldings(
      db,
      accountId,
      held.map((h) => ({
        symbol: h.symbol,
        name: h.name,
        assetClass: h.assetClass,
        quantity: h.quantity,
        costBasisMinor: h.costBasisMinor,
        fallbackPrice: h.price,
        fallbackValueMinor: h.valueMinor,
      })),
      today,
      now,
    );
    changed += 1;
  }
  return changed;
}

/** Applies what is due and refreshes values, for every TSP account. Run at launch and now and then. */
export function updateAllTspAccounts(
  db: AppDb,
  options: { today?: string | undefined; now?: string | undefined } = {},
): { applied: number; refreshed: number; waiting: number } {
  const applied = applyDueContributions(db, options);
  const refreshed = refreshTspValues(db, options);
  return { applied: applied.applied, refreshed, waiting: applied.waiting.length };
}

// ---- What the screen shows ------------------------------------------------------------------

export interface TspFundPrice {
  symbol: string;
  code: string;
  name: string;
  price: number | null;
  date: string | null;
}

export interface TspSettings {
  accountId: number;
  allocations: AllocationDto[];
  contributions: ContributionDto[];
  /** The newest price of each fund in the split or held. */
  prices: TspFundPrice[];
  waiting: ApplyResult["waiting"];
  /** What has been bought by contributions, most recent first. */
  recent: Array<{
    date: string;
    contributionId: number;
    amountMinor: number;
    /** Of the amount, what the employer put in. */
    employerMinor: number;
    parts: Array<{
      symbol: string;
      code: string;
      units: number;
      price: number;
      priceDate: string;
      amountMinor: number;
    }>;
  }>;
}

export function getTspSettings(
  db: AppDb,
  accountId: number,
  today = new Date().toISOString().slice(0, 10),
): TspSettings {
  requireTspAccount(db, accountId);
  const allocations = getAllocations(db, accountId);
  const contributions = db
    .select()
    .from(tspContributions)
    .where(eq(tspContributions.accountId, accountId))
    .orderBy(asc(tspContributions.id))
    .all();
  const held = heldFunds(db, accountId);
  const symbols = [...new Set([...allocations.map((a) => a.symbol), ...held.map((h) => h.symbol)])]
    .filter((s) => findKnownFund(s))
    .sort();
  const latest = latestPrices(db, symbols);
  const prices: TspFundPrice[] = symbols.map((symbol) => {
    const fund = findKnownFund(symbol)!;
    const l = latest.get(symbol);
    return {
      symbol,
      code: fund.code,
      name: fund.name,
      price: l?.price ?? null,
      date: l?.date ?? null,
    };
  });

  const ids = contributions.map((c) => c.id);
  const applications =
    ids.length === 0
      ? []
      : db
          .select()
          .from(tspContributionApplications)
          .where(inArray(tspContributionApplications.contributionId, ids))
          .orderBy(desc(tspContributionApplications.date), asc(tspContributionApplications.symbol))
          .all();
  const byDay = new Map<string, TspSettings["recent"][number]>();
  for (const a of applications) {
    const key = `${a.contributionId}|${a.date}`;
    const entry = byDay.get(key) ?? {
      date: a.date,
      contributionId: a.contributionId,
      amountMinor: 0,
      employerMinor: 0,
      parts: [],
    };
    entry.amountMinor += a.amountMinor;
    entry.employerMinor += a.employerMinor;
    entry.parts.push({
      symbol: a.symbol,
      code: findKnownFund(a.symbol)?.code ?? a.symbol,
      units: a.units,
      price: a.price,
      priceDate: a.priceDate,
      amountMinor: a.amountMinor,
    });
    byDay.set(key, entry);
  }

  // Days that are due but cannot be turned into units yet, worked out without changing anything.
  const waiting: ApplyResult["waiting"] = [];
  const shares = allocations.map((a) => a.symbol);
  for (const c of contributions.filter((x) => x.active)) {
    const done = new Set(applications.filter((a) => a.contributionId === c.id).map((a) => a.date));
    for (const date of dueDates(c, c.startDate, today)) {
      if (done.has(date) || shares.length === 0) continue;
      const missing = shares.filter((s) => priceOnOrBefore(db, s, date) === null);
      if (missing.length > 0) waiting.push({ contributionId: c.id, date, missing });
    }
  }

  return {
    accountId,
    allocations,
    contributions: contributions.map((c) => contributionDto(c, today)),
    prices,
    waiting,
    recent: [...byDay.values()].slice(0, 12),
  };
}

export const TSP_FUND_LIST = TSP_FUNDS;
