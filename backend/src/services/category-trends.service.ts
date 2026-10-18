import { sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import { addDays, isRealDate, listDays } from "../utils/dates.js";
import { accountScope } from "./account-scope.js";
import { dateOf, IS_INCOME, NOT_TRANSFER, type DateBasis } from "./analytics.service.js";

/**
 * Spending by category over time, for the Insights page's category explorer: for each chosen
 * category (or each of their subcategories), how much was spent and in how many transactions, in
 * each week, month, quarter, or year of a period; with all spending per period (for shares) and
 * the same figures for the period just before (for comparing).
 *
 * Spending is counted as everywhere else: transfers between the user's own accounts and income are
 * left out, refunds lower spending, and a split transaction counts each part in its own category.
 */

export type TrendInterval = "week" | "month" | "quarter" | "year";
export const TREND_INTERVALS = ["week", "month", "quarter", "year"] as const;

export interface TrendQuery {
  from: string;
  to: string;
  interval: TrendInterval;
  /** Top-level or sub categories; 0 is "Uncategorized". Empty: every top-level category. */
  categories: number[];
  /** Show each chosen category's subcategories as their own series (a parent's own spending too). */
  splitSubcategories: boolean;
  /** Only these accounts (empty: every account that counts in totals). */
  accounts: number[];
  includePending: boolean;
  dateBasis?: DateBasis | undefined;
  environment: string;
  /**
   * `out` (the default): spending, as everywhere else. `in`: all money coming in, by category:
   * income, incoming transfers, refunds and other credits (a copy of a purchase shown on a second
   * account, such as PayPal and its card, is counted once). Values are then positive amounts in.
   */
  flow?: TrendFlow | undefined;
}

/**
 * `out`: spending. `in`: money in. `all`: every transaction, each category's money out and money
 * in as lines of their own (positive amounts), transfers and income included.
 */
export type TrendFlow = "out" | "in" | "all";
export const TREND_FLOWS = ["out", "in", "all"] as const;

export interface TrendBucket {
  key: string;
  label: string;
  from: string;
  to: string;
}

export interface TrendSeries {
  key: string;
  /** The category the series is (null for "Uncategorized"). */
  categoryId: number | null;
  /** For a subcategory, its parent. */
  parentId: number | null;
  label: string;
  color: string | null;
  /** With every transaction (`flow: all`): whether the line is the category's money in or out. */
  direction?: "in" | "out";
  /** Per bucket: spending (refunds take away) and how many transactions. */
  values: number[];
  counts: number[];
  /** The same, for the period of the same length just before. */
  previousTotal: number;
  previousCount: number;
}

export interface Trends {
  from: string;
  to: string;
  interval: TrendInterval;
  buckets: TrendBucket[];
  series: TrendSeries[];
  /** All spending per bucket, every category, for shares. */
  allSpending: number[];
  previous: { from: string; to: string };
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The bucket a day falls in, as SQL and as plain code (they must agree). */
function bucketSql(interval: TrendInterval, day: SQL): SQL {
  switch (interval) {
    case "week":
      return sql`date(${day}, 'weekday 0', '-6 days')`;
    case "month":
      return sql`substr(${day}, 1, 7)`;
    case "quarter":
      return sql`substr(${day}, 1, 4) || '-Q' || ((cast(substr(${day}, 6, 2) as integer) + 2) / 3)`;
    case "year":
      return sql`substr(${day}, 1, 4)`;
  }
}

function bucketOf(interval: TrendInterval, day: string): TrendBucket {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  switch (interval) {
    case "week": {
      const d = new Date(`${day}T00:00:00Z`);
      const back = (d.getUTCDay() + 6) % 7; // Monday starts the week
      const start = addDays(day, -back);
      return {
        key: start,
        label: `Week of ${MONTHS[Number(start.slice(5, 7)) - 1]} ${Number(start.slice(8, 10))}`,
        from: start,
        to: addDays(start, 6),
      };
    }
    case "month": {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return {
        key: `${y}-${pad(m)}`,
        label: `${MONTHS[m - 1]} ${y}`,
        from: `${y}-${pad(m)}-01`,
        to: `${y}-${pad(m)}-${pad(last)}`,
      };
    }
    case "quarter": {
      const q = Math.floor((m - 1) / 3) + 1;
      const endMonth = q * 3;
      const last = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
      return {
        key: `${y}-Q${q}`,
        label: `Q${q} ${y}`,
        from: `${y}-${pad(endMonth - 2)}-01`,
        to: `${y}-${pad(endMonth)}-${pad(last)}`,
      };
    }
    case "year":
      return { key: String(y), label: String(y), from: `${y}-01-01`, to: `${y}-12-31` };
  }
}

/** Every bucket the period touches, in order. */
export function bucketsFor(interval: TrendInterval, from: string, to: string): TrendBucket[] {
  const out: TrendBucket[] = [];
  let day = from;
  while (day <= to) {
    const b = bucketOf(interval, day);
    out.push(b);
    day = addDays(b.to, 1);
  }
  return out;
}

interface Row {
  bucket: string;
  key: number;
  spending: number | null;
  n: number;
}

export function categoryTrends(db: AppDb, q: TrendQuery): Trends {
  if (!isRealDate(q.from) || !isRealDate(q.to)) {
    throw new AppError(
      400,
      "invalid_date",
      "Dates must be real calendar dates written YYYY-MM-DD.",
    );
  }
  if (q.from > q.to)
    throw new AppError(400, "invalid_range", "The start date is after the end date.");
  const days = listDays(q.from, q.to).length;
  if (days > 366 * 15)
    throw new AppError(400, "range_too_long", "Choose a period of 15 years or less.");
  if (q.interval === "week" && days > 366 * 3) {
    throw new AppError(
      400,
      "range_too_long",
      "Weeks work for up to 3 years; choose months for longer.",
    );
  }

  const categories = db.all<{
    id: number;
    name: string;
    color: string | null;
    parent_id: number | null;
  }>(sql`select id, name, color, parent_id from categories`);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const chosen =
    q.categories.length > 0
      ? q.categories
      : [...categories.filter((c) => c.parent_id === null).map((c) => c.id), 0];

  // What each transaction's category counts as: the chosen category it is in (a subcategory of a
  // chosen parent counts as the parent), or, split, its own subcategory.
  const seriesKey = q.splitSubcategories
    ? sql`coalesce(c.id, 0)`
    : sql`(case when c.id is null then 0 when c.id in (${list(chosen)}) then c.id else coalesce(c.parent_id, c.id) end)`;
  const inChosen = sql`(coalesce(c.id, 0) in (${list(chosen)}) or coalesce(c.parent_id, -1) in (${list(chosen)}))`;

  const day = dateOf(q.dateBasis);
  const moneyIn = q.flow === "in";
  const everything = q.flow === "all";
  const base = (from: string, to: string): SQL[] => {
    const parts: SQL[] = [
      sql`${day} >= ${from}`,
      sql`${day} <= ${to}`,
      sql`(p.environment = ${q.environment} or a.plaid_item_id is null)`,
      accountScope(undefined),
      ...(everything
        ? // Every transaction, transfers and income included; a copy of one shown on a second
          // account (PayPal and the card that paid) counts once.
          [sql`coalesce(t.transfer_source, '') <> 'mirror'`]
        : moneyIn
          ? [
              // Every amount that came in, transfers and income included; a copy of one shown on a
              // second account counts once.
              sql`t.amount_minor < 0`,
              sql`coalesce(t.transfer_source, '') <> 'mirror'`,
            ]
          : [
              NOT_TRANSFER,
              // Not income. (A case, not "not": the test can be unknown, which "not" would drop.)
              sql`(case when ${IS_INCOME} then 0 else 1 end) = 1`,
            ]),
    ];
    if (q.accounts.length > 0) parts.push(sql`t.account_id in (${list(q.accounts)})`);
    if (!q.includePending) parts.push(sql`t.pending = 0`);
    return parts;
  };
  const from = sql`from transaction_lines t
    join accounts a on a.id = t.account_id
    left join plaid_items p on p.id = a.plaid_item_id
    left join categories c on c.id = t.category_id`;

  const bucket = bucketSql(q.interval, day);
  // Spending is the amounts as they are (refunds take away); money in alone is shown as positive.
  // With every transaction each line is money out (positive) or money in (negative), as on the
  // ledger the other way round: spending counts up, money coming in counts down.
  const amount = everything
    ? sql`sum(t.amount_minor)`
    : moneyIn
      ? sql`-sum(t.amount_minor)`
      : sql`sum(t.amount_minor)`;
  // All the money that moved in a period, both ways, for shares (always positive).
  const allAmount = everything ? sql`sum(abs(t.amount_minor))` : amount;
  // Which way the money went: 1 in, 0 out (only told apart with every transaction).
  const dir = everything ? sql`(t.amount_minor < 0)` : sql`0`;
  const rows = db.all<Row & { dir: number }>(sql`
    select ${bucket} as bucket, ${seriesKey} as key, ${dir} as dir, ${amount} as spending,
      count(distinct t.id) as n
    ${from}
    where ${sql.join([...base(q.from, q.to), inChosen], sql` and `)}
    group by 1, 2, 3`);
  const all = db.all<{ bucket: string; spending: number | null }>(sql`
    select ${bucket} as bucket, ${allAmount} as spending
    ${from}
    where ${sql.join(base(q.from, q.to), sql` and `)}
    group by 1`);

  // The period just before, of the same length (in whole months when the period is whole months).
  const { prevFrom, prevTo } = previousPeriod(q.from, q.to, days);
  const prev = db.all<{ key: number; dir: number; spending: number | null; n: number }>(sql`
    select ${seriesKey} as key, ${dir} as dir, ${amount} as spending, count(distinct t.id) as n
    ${from}
    where ${sql.join([...base(prevFrom, prevTo), inChosen], sql` and `)}
    group by 1, 2`);

  const buckets = bucketsFor(q.interval, q.from, q.to);
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  const series = new Map<string, TrendSeries>();
  const seriesFor = (key: number, inflow = false): TrendSeries => {
    const id = everything ? `${key}:${inflow ? "in" : "out"}` : String(key);
    let s = series.get(id);
    if (!s) {
      const c = key === 0 ? undefined : byId.get(key);
      const parent = c?.parent_id ? byId.get(c.parent_id) : undefined;
      // A parent's own spending, when split from its subcategories, says so.
      const name =
        key === 0
          ? "Uncategorized"
          : q.splitSubcategories &&
              c &&
              c.parent_id === null &&
              categories.some((x) => x.parent_id === c.id)
            ? `${c.name} (general)`
            : (c?.name ?? "Unknown");
      s = {
        key: id,
        categoryId: key === 0 ? null : key,
        parentId: c?.parent_id ?? null,
        label: everything ? `${name} · ${inflow ? "in" : "out"}` : name,
        color: c?.color ?? parent?.color ?? null,
        ...(everything ? { direction: inflow ? ("in" as const) : ("out" as const) } : {}),
        values: buckets.map(() => 0),
        counts: buckets.map(() => 0),
        previousTotal: 0,
        previousCount: 0,
      };
      series.set(id, s);
    }
    return s;
  };
  // Every chosen category shows, even with nothing spent (so a line at zero says "nothing"). With
  // every transaction only the directions that happened show, so a category is not doubled.
  if (!q.splitSubcategories && !everything) for (const id of chosen) seriesFor(id);
  for (const r of rows) {
    const i = index.get(r.bucket);
    if (i === undefined) continue;
    const s = seriesFor(r.key, r.dir === 1);
    s.values[i]! += r.spending ?? 0;
    s.counts[i]! += r.n;
  }
  for (const r of prev) {
    // A line only from the period before is not added (it has nothing in this period).
    const id = everything ? `${r.key}:${r.dir === 1 ? "in" : "out"}` : String(r.key);
    if (everything && !series.has(id)) continue;
    const s = seriesFor(r.key, r.dir === 1);
    s.previousTotal += r.spending ?? 0;
    s.previousCount += r.n;
  }
  const allSpending = buckets.map(() => 0);
  for (const r of all) {
    const i = index.get(r.bucket);
    if (i !== undefined) allSpending[i] = r.spending ?? 0;
  }
  // Biggest first, money in (negative with every transaction) by its size too.
  const total = (s: TrendSeries) => Math.abs(s.values.reduce((n, v) => n + v, 0));
  return {
    from: q.from,
    to: q.to,
    interval: q.interval,
    buckets,
    series: [...series.values()].sort(
      (a, b) => total(b) - total(a) || a.label.localeCompare(b.label),
    ),
    allSpending,
    previous: { from: prevFrom, to: prevTo },
  };
}

const list = (ids: number[]) =>
  sql.join(
    (ids.length > 0 ? ids : [-1]).map((id) => sql`${id}`),
    sql`, `,
  );

/** The period of the same length just before: whole months back when it is whole months. */
export function previousPeriod(
  from: string,
  to: string,
  days: number,
): { prevFrom: string; prevTo: string } {
  const prevTo = addDays(from, -1);
  const monthEnd = addDays(to, 1).slice(8, 10) === "01";
  if (from.slice(8, 10) === "01" && monthEnd) {
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      Number(to.slice(5, 7)) -
      Number(from.slice(5, 7)) +
      1;
    const start = new Date(
      Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1 - months, 1),
    );
    return { prevFrom: start.toISOString().slice(0, 10), prevTo };
  }
  return { prevFrom: addDays(prevTo, -(days - 1)), prevTo };
}
