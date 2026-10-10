import { asc, inArray, sql } from "drizzle-orm";
import { balanceSnapshots } from "../../../drizzle/schema.js";
import type { AppDb } from "../db/client.js";
import { addDays, addMonths, isRealDate, lastOfMonth, mondayOf, monthOf } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { listAccounts } from "./account.service.js";
import { getSettings } from "./settings.service.js";

/**
 * Net worth over time as a continuous series, one point per day, week, or month.
 *
 * Each account's balance is known for every day from the balances the app recorded (each sync, each
 * manual update) and, between and before those, from its own transactions:
 *
 *   - A cash account or a card is wound back (or forward) from the nearest recorded balance by the
 *     posted transactions in between, exactly as the calendar does. A deposit account's balance is
 *     the later balance plus what left it since; a card's debt is the later debt minus what was
 *     added to it since.
 *   - Anything without transactions to wind (investments, loans, other assets) keeps its most
 *     recently recorded balance until the next one, and before its first record is held at that
 *     first balance. That is an assumption (the app cannot know what it was), but leaving it out
 *     would make net worth jump the day it was first connected.
 *   - A cash account or card is held at the balance it started with before its first transaction
 *     or record, for the same reason.
 *
 * A week or a month is shown at its last day, so each point is the net worth at the END of that
 * period. Every point says how many accounts were recorded that day, rebuilt from transactions,
 * or carried forward, so the figure's basis is never hidden.
 */

export const GRANULARITIES = ["day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The longest stretch worked out in one go (about eleven years). */
const MAX_DAYS = 4000;
/** The most points one request returns, so a daily series over many years is refused, not slow. */
const MAX_POINTS = 1100;

export interface SeriesPoint {
  /** The last day of the period (or today, for a period still going). */
  date: string;
  /** The first day of the period. */
  periodStart: string;
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  /** Net worth less the previous point's; null for the first. */
  changeMinor: number | null;
  /** How the accounts in this total were known on that day. */
  accounts: { recorded: number; rebuilt: number; carried: number };
}

export interface NetWorthSeries {
  currency: string;
  granularity: Granularity;
  /** Accounts that count today. */
  accountsTotal: number;
  /** The first day any account has a known balance, or null when none does. */
  firstDay: string | null;
  /** The first day a balance was actually recorded; earlier days are rebuilt from transactions. */
  recordedFrom: string | null;
  points: SeriesPoint[];
}

type Kind = "recorded" | "rebuilt" | "carried";

interface Known {
  value: number;
  kind: Kind;
}

const LIABILITY_TYPES = new Set(["credit", "loan"]);
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** Every period end from `from` to `to`, each with its first day. The last may be a period in progress. */
function periods(
  from: string,
  to: string,
  granularity: Granularity,
): Array<{ start: string; end: string }> {
  const list: Array<{ start: string; end: string }> = [];
  if (granularity === "day") {
    for (let d = from; d <= to; d = addDays(d, 1)) list.push({ start: d, end: d });
  } else if (granularity === "week") {
    for (let start = mondayOf(from); start <= to; start = addDays(start, 7)) {
      list.push({ start, end: addDays(start, 6) < to ? addDays(start, 6) : to });
    }
  } else {
    for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) {
      const end = lastOfMonth(m);
      list.push({ start: `${m}-01`, end: end < to ? end : to });
    }
  }
  return list;
}

export function netWorthSeries(
  db: AppDb,
  options: {
    granularity: Granularity;
    from?: string | undefined;
    to?: string | undefined;
    today?: string | undefined;
  },
): NetWorthSeries {
  const { granularity } = options;
  if (!GRANULARITIES.includes(granularity)) {
    throw new AppError(400, "invalid_granularity", "Choose day, week, or month.");
  }
  for (const day of [options.from, options.to]) {
    if (day !== undefined && !isRealDate(day)) {
      throw new AppError(400, "invalid_date", "Dates must be real days written as YYYY-MM-DD.");
    }
  }
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const settings = getSettings(db);
  const counted = listAccounts(db).filter(
    (a) =>
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment) &&
      a.currency === settings.currency,
  );
  const empty: NetWorthSeries = {
    currency: settings.currency,
    granularity,
    accountsTotal: counted.length,
    firstDay: null,
    recordedFrom: null,
    points: [],
  };
  if (counted.length === 0) return empty;
  const ids = counted.map((a) => a.id);

  // What was recorded: the last balance of each account on each day.
  const recorded = new Map<number, Map<string, number>>();
  const snapshots = db
    .select({
      accountId: balanceSnapshots.accountId,
      observedAt: balanceSnapshots.observedAt,
      valueMinor: balanceSnapshots.currentBalanceMinor,
    })
    .from(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, ids))
    .orderBy(asc(balanceSnapshots.observedAt), asc(balanceSnapshots.id))
    .all();
  for (const s of snapshots) {
    if (s.valueMinor === null) continue;
    const days = recorded.get(s.accountId) ?? new Map<string, number>();
    days.set(s.observedAt.slice(0, 10), s.valueMinor);
    recorded.set(s.accountId, days);
  }

  // What went in and out: each account's posted transactions, summed by day.
  const flows = new Map<number, Map<string, number>>();
  for (const r of db.all<{ account_id: number; date: string; total: number }>(sql`
    select account_id, date, sum(amount_minor) as total
    from transactions
    where pending = 0 and account_id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    group by account_id, date`)) {
    const days = flows.get(r.account_id) ?? new Map<string, number>();
    days.set(r.date, r.total);
    flows.set(r.account_id, days);
  }

  // The span worked out: from the earliest day any account is known, to today.
  const starts = new Map<number, string>();
  for (const a of counted) {
    const own = [...(recorded.get(a.id)?.keys() ?? [])];
    if (own.length === 0) continue; // never recorded, so there is nothing to build from
    const winds = a.type === "depository" || a.type === "credit";
    if (winds) own.push(...(flows.get(a.id)?.keys() ?? []));
    starts.set(a.id, own.sort()[0]!);
  }
  if (starts.size === 0) return empty;
  let firstDay = [...starts.values()].sort()[0]!;
  const earliestAllowed = addDays(today, -(MAX_DAYS - 1));
  if (firstDay < earliestAllowed) firstDay = earliestAllowed;
  const recordedFrom = [...recorded.values()].flatMap((days) => [...days.keys()]).sort()[0] as
    string | undefined;
  const length = dayNumber(today) - dayNumber(firstDay) + 1;
  if (length < 1) return { ...empty, firstDay: today, recordedFrom: recordedFrom ?? null };
  const index = (day: string): number => dayNumber(day) - dayNumber(firstDay);

  // One known balance (or none) per account per day.
  const known = new Map<number, Array<Known | null>>();
  for (const a of counted) {
    const start = starts.get(a.id);
    if (start === undefined) continue;
    const days = recorded.get(a.id)!;
    const obsDays = [...days.keys()].sort();
    const winds = a.type === "depository" || a.type === "credit";
    const sign = a.type === "credit" ? -1 : 1;
    const line: Array<Known | null> = Array<Known | null>(length).fill(null);

    if (!winds) {
      // Carried forward: the last recorded balance holds until the next one.
      // It starts from the latest balance recorded before the span, or else the very first one.
      let last = days.get(obsDays.filter((d) => d < firstDay).at(-1) ?? obsDays[0]!)!;
      for (let i = 0; i < length; i++) {
        const seen = days.get(addDays(firstDay, i));
        if (seen !== undefined) {
          last = seen;
          line[i] = { value: seen, kind: "recorded" };
        } else {
          line[i] = { value: last, kind: "carried" };
        }
      }
      known.set(a.id, line);
      continue;
    }

    // Running total of the account's flows by day, so the sum over any stretch is a difference.
    const flow = flows.get(a.id) ?? new Map<string, number>();
    const cumulative = new Float64Array(length + 1); // cumulative[i] = flows on days < index i
    let before = 0;
    for (const [day, total] of flow) if (day < firstDay) before += total;
    cumulative[0] = before;
    for (let i = 0; i < length; i++) {
      cumulative[i + 1] = cumulative[i]! + (flow.get(addDays(firstDay, i)) ?? 0);
    }
    /** Flows on days after index `a` up to and including index `b` (a < b). */
    const between = (a2: number, b: number): number => cumulative[b + 1]! - cumulative[a2 + 1]!;

    // The recorded balances as (index, value) in order, with those before the span folded in.
    const marks = obsDays
      .map((d) => ({ i: index(d), v: days.get(d)! }))
      .filter((m) => m.i < length);
    /** The balance at the end of day `i`, worked from the nearest recorded balance. */
    const rebuild = (i: number): number | null => {
      let prev: { i: number; v: number } | undefined;
      let next: { i: number; v: number } | undefined;
      for (const m of marks) {
        if (m.i < i) prev = m;
        else if (m.i > i) {
          next = m;
          break;
        }
      }
      const useNext = next !== undefined && (prev === undefined || next.i - i <= i - prev.i);
      // Earlier than a balance: add back what left since (or take away what was added).
      if (useNext) return next!.v + sign * between(i, next!.i);
      if (prev !== undefined) return prev.v - sign * between(prev.i, i);
      return null;
    };
    const startIndex = Math.max(0, index(start));
    for (let i = startIndex; i < length; i++) {
      const own = marks.find((m) => m.i === i);
      if (own) line[i] = { value: own.v, kind: "recorded" };
      else {
        const value = rebuild(i);
        if (value !== null) line[i] = { value, kind: "rebuilt" };
      }
    }
    // Before its first transaction or record, hold the balance it started with, so the total does
    // not jump on the day the account first appears. (What it was before then is not known.)
    if (index(start) > 0) {
      const opening = rebuild(index(start) - 1);
      if (opening !== null) {
        for (let i = 0; i < index(start); i++) line[i] = { value: opening, kind: "carried" };
      }
    }
    known.set(a.id, line);
  }

  // The totals, at the end of each period.
  const from = options.from ?? firstDay;
  const to = options.to !== undefined && options.to < today ? options.to : today;
  if (from > to) throw new AppError(400, "invalid_range", "The start date is after the end date.");
  const list = periods(from < firstDay ? firstDay : from, to, granularity);
  if (list.length > MAX_POINTS) {
    throw new AppError(
      400,
      "range_too_long",
      "That is too many points. Choose weeks or months, or a shorter period.",
    );
  }

  const points: SeriesPoint[] = [];
  for (const period of list) {
    const at = index(period.end);
    if (at < 0 || at >= length) continue;
    let assets = 0;
    let liabilities = 0;
    const counts = { recorded: 0, rebuilt: 0, carried: 0 };
    for (const a of counted) {
      const here = known.get(a.id)?.[at];
      if (!here) continue;
      if (LIABILITY_TYPES.has(a.type)) liabilities += here.value;
      else assets += here.value;
      counts[here.kind] += 1;
    }
    if (counts.recorded + counts.rebuilt + counts.carried === 0) continue;
    const previous = points.at(-1);
    points.push({
      date: period.end,
      periodStart: period.start < firstDay ? firstDay : period.start,
      assetsMinor: assets,
      liabilitiesMinor: liabilities,
      netWorthMinor: assets - liabilities,
      changeMinor: previous ? assets - liabilities - previous.netWorthMinor : null,
      accounts: counts,
    });
  }
  return { ...empty, firstDay, recordedFrom: recordedFrom ?? null, points };
}
