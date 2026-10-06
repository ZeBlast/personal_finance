import { sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { AppError } from "../utils/errors.js";
import {
  firstOfMonth,
  isRealDate,
  isRealMonth,
  lastOfMonth,
  listDays,
  listMonths,
  listWeeks,
} from "../utils/dates.js";
import { listAccounts } from "./account.service.js";
import { creditLimitHistoryFor } from "./credit-limit.service.js";
import { getSettings } from "./settings.service.js";

/**
 * What "spending" and "income" mean in every chart and budget (one definition, used everywhere):
 *
 * - Transfers are left out by default: anything marked as a transfer (money moving between your own
 *   accounts or to a person, such as Zelle) and credit-card payments, which would otherwise count
 *   the same money twice (once when it was spent on the card, again when the card was paid).
 * - **Income** is money in on transactions categorized as income (by the bank, or by a category named
 *   "Income"). Everything else is **spending**.
 * - Refunds are negative spending: a refund reduces the spending of its category rather than
 *   counting as income, so a returned purchase nets out.
 * - Pending transactions are included unless asked otherwise.
 */
const IS_INCOME = sql`(t.plaid_category_primary = 'INCOME' or lower(coalesce(c.name, '')) = 'income')`;
/**
 * Not money moving between accounts. Besides transfers and the bank's own "credit card payment"
 * category, this leaves out any loan payment that sits on a credit card account: that is a payment
 * TO the card (found against Plaid Sandbox, which labels card payments "other payment" instead).
 * A loan payment on a checking account, such as a mortgage, still counts as spending.
 */
export const NOT_TRANSFER = sql`(t.is_transfer = 0
  and coalesce(t.plaid_category_detailed, '') <> 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
  and not (a.type = 'credit' and coalesce(t.plaid_category_primary, '') = 'LOAN_PAYMENTS'))`;
const MERCHANT = sql`coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name)`;

export const GROUPS = [
  "none",
  "day",
  "week",
  "month",
  "category",
  "merchant",
  "account",
  "institution",
] as const;
export type Group = (typeof GROUPS)[number];

export interface SummaryQuery {
  from: string;
  to: string;
  groupBy: Group;
  accountId?: number | undefined;
  /** A category ID (including its subcategories) or "none" for uncategorized. */
  category?: number | "none" | undefined;
  /** For `groupBy=category`: show subcategories under their parent. */
  rollupToParent?: boolean | undefined;
  includeTransfers: boolean;
  includePending: boolean;
  /** Keep this many groups and fold the rest into one "Other" row. */
  limit?: number | undefined;
  /** For time groups: include periods with no transactions, as zeros, so charts have no gaps. */
  fill: boolean;
  environment: string;
}

export interface SummaryRow {
  key: string;
  label: string;
  color: string | null;
  spendingMinor: number;
  incomeMinor: number;
  netMinor: number;
  count: number;
}

export interface Summary {
  from: string;
  to: string;
  groupBy: Group;
  rows: SummaryRow[];
  totals: Omit<SummaryRow, "key" | "label" | "color">;
}

interface GroupSql {
  key: SQL;
  label: SQL;
  color: SQL;
  extraJoin?: SQL;
}

function groupSql(group: Group, rollup: boolean): GroupSql {
  switch (group) {
    case "none":
      return { key: sql`'all'`, label: sql`'All'`, color: sql`null` };
    case "day":
      return { key: sql`t.date`, label: sql`t.date`, color: sql`null` };
    case "week":
      return {
        key: sql`date(t.date, 'weekday 0', '-6 days')`,
        label: sql`date(t.date, 'weekday 0', '-6 days')`,
        color: sql`null`,
      };
    case "month":
      return { key: sql`substr(t.date, 1, 7)`, label: sql`substr(t.date, 1, 7)`, color: sql`null` };
    case "category":
      return rollup
        ? {
            key: sql`coalesce(c.parent_id, c.id, 0)`,
            label: sql`coalesce(pc.name, c.name, 'Uncategorized')`,
            color: sql`coalesce(pc.color, c.color)`,
            extraJoin: sql`left join categories pc on pc.id = c.parent_id`,
          }
        : {
            key: sql`coalesce(c.id, 0)`,
            label: sql`coalesce(c.name, 'Uncategorized')`,
            color: sql`c.color`,
          };
    case "merchant":
      // Merchants are matched ignoring case and stray spaces. The label shown is one spelling from
      // the group (the query keeps the largest), which is arbitrary but always the same.
      return {
        key: sql`lower(trim(${MERCHANT}))`,
        label: sql`trim(${MERCHANT})`,
        color: sql`null`,
      };
    case "account":
      return { key: sql`a.id`, label: sql`a.name`, color: sql`a.color` };
    case "institution":
      return {
        key: sql`coalesce(p.institution_name, 'Manual accounts')`,
        label: sql`coalesce(p.institution_name, 'Manual accounts')`,
        color: sql`null`,
      };
  }
}

/** Checks the query's dates, with a range cap so one request cannot ask for a decade by day. */
export function validateRange(from: string, to: string, groupBy: Group): void {
  if (!isRealDate(from) || !isRealDate(to)) {
    throw new AppError(
      400,
      "invalid_date",
      "Dates must be real calendar dates written YYYY-MM-DD.",
    );
  }
  if (from > to) throw new AppError(400, "invalid_range", "The start date is after the end date.");
  const days = listDays(from, to).length;
  const limit = groupBy === "day" ? 800 : 20_000;
  if (days > limit) {
    throw new AppError(400, "range_too_long", "That date range is too long for this grouping.");
  }
}

function whereClauses(
  q: Pick<
    SummaryQuery,
    "from" | "to" | "accountId" | "category" | "includeTransfers" | "includePending" | "environment"
  >,
): SQL {
  const parts: SQL[] = [
    sql`t.date >= ${q.from}`,
    sql`t.date <= ${q.to}`,
    sql`(p.environment = ${q.environment} or a.plaid_item_id is null)`,
  ];
  if (q.accountId !== undefined) parts.push(sql`t.account_id = ${q.accountId}`);
  if (q.category === "none") parts.push(sql`t.category_id is null`);
  else if (q.category !== undefined) {
    parts.push(sql`(t.category_id = ${q.category} or c.parent_id = ${q.category})`);
  }
  if (!q.includeTransfers) parts.push(NOT_TRANSFER);
  if (!q.includePending) parts.push(sql`t.pending = 0`);
  return sql.join(parts, sql` and `);
}

interface RawRow {
  key: string | number;
  label: string | null;
  color: string | null;
  spending: number | null;
  income: number | null;
  n: number;
}

const fromTransactions = sql`from transactions t
  join accounts a on a.id = t.account_id
  left join plaid_items p on p.id = a.plaid_item_id
  left join categories c on c.id = t.category_id`;

/** Spending and income for any period, grouped any of the ways above. This one query feeds most widgets. */
export function summarize(db: AppDb, q: SummaryQuery): Summary {
  validateRange(q.from, q.to, q.groupBy);
  const g = groupSql(q.groupBy, q.rollupToParent ?? false);
  const raw = db.all<RawRow>(sql`
    select ${g.key} as key, max(${g.label}) as label, max(${g.color}) as color,
      sum(case when ${IS_INCOME} then 0 else t.amount_minor end) as spending,
      -sum(case when ${IS_INCOME} then t.amount_minor else 0 end) as income,
      count(*) as n
    ${fromTransactions} ${g.extraJoin ?? sql``}
    where ${whereClauses(q)}
    group by ${g.key}
  `);

  let rows: SummaryRow[] = raw.map((r) => {
    const spendingMinor = r.spending ?? 0;
    const incomeMinor = r.income ?? 0;
    return {
      key: String(r.key),
      label: r.label ?? String(r.key),
      color: r.color,
      spendingMinor,
      incomeMinor,
      netMinor: incomeMinor - spendingMinor,
      count: r.n,
    };
  });

  const totals = rows.reduce(
    (sum, r) => ({
      spendingMinor: sum.spendingMinor + r.spendingMinor,
      incomeMinor: sum.incomeMinor + r.incomeMinor,
      netMinor: sum.netMinor + r.netMinor,
      count: sum.count + r.count,
    }),
    { spendingMinor: 0, incomeMinor: 0, netMinor: 0, count: 0 },
  );

  const timeKeys =
    q.groupBy === "day"
      ? listDays(q.from, q.to)
      : q.groupBy === "week"
        ? listWeeks(q.from, q.to)
        : q.groupBy === "month"
          ? listMonths(q.from, q.to)
          : null;

  if (timeKeys) {
    if (q.fill) {
      const byKey = new Map(rows.map((r) => [r.key, r]));
      rows = timeKeys.map(
        (key) =>
          byKey.get(key) ?? {
            key,
            label: key,
            color: null,
            spendingMinor: 0,
            incomeMinor: 0,
            netMinor: 0,
            count: 0,
          },
      );
    } else {
      rows.sort((a, b) => (a.key < b.key ? -1 : 1));
    }
  } else {
    // Biggest first; ties by label so the order never jumps around.
    rows.sort((a, b) => b.spendingMinor - a.spendingMinor || a.label.localeCompare(b.label));
    if (q.limit !== undefined && rows.length > q.limit) {
      const kept = rows.slice(0, q.limit);
      const rest = rows.slice(q.limit);
      const other = rest.reduce(
        (sum, r) => ({
          ...sum,
          spendingMinor: sum.spendingMinor + r.spendingMinor,
          incomeMinor: sum.incomeMinor + r.incomeMinor,
          netMinor: sum.netMinor + r.netMinor,
          count: sum.count + r.count,
        }),
        {
          key: "other",
          label: "Other",
          color: null,
          spendingMinor: 0,
          incomeMinor: 0,
          netMinor: 0,
          count: 0,
        } as SummaryRow,
      );
      rows = [...kept, other];
    }
  }

  return { from: q.from, to: q.to, groupBy: q.groupBy, rows, totals };
}

/** Net spending in one category (and its subcategories) over a month, used by budgets. */
export function categorySpending(
  db: AppDb,
  categoryId: number,
  month: string,
  environment: string,
): number {
  return summarize(db, {
    from: firstOfMonth(month),
    to: lastOfMonth(month),
    groupBy: "none",
    category: categoryId,
    includeTransfers: false,
    includePending: true,
    fill: false,
    environment,
  }).totals.spendingMinor;
}

// ---- Calendar ---------------------------------------------------------------------------

export interface CalendarDay {
  date: string;
  count: number;
  pendingCount: number;
  /** Money that left your accounts that day, and money that came in (transfers included). */
  outflowMinor: number;
  inflowMinor: number;
  accounts: Array<{
    accountId: number;
    name: string;
    color: string | null;
    count: number;
    outflowMinor: number;
    inflowMinor: number;
  }>;
}

interface CalendarRow {
  date: string;
  account_id: number;
  name: string;
  color: string | null;
  n: number;
  pending: number;
  outflow: number | null;
  inflow: number | null;
}

/** What happened on each day of a month, and on which account. Days with nothing are omitted. */
export function calendarMonth(
  db: AppDb,
  month: string,
  environment: string,
  accountId?: number,
): { month: string; days: CalendarDay[] } {
  if (!isRealMonth(month))
    throw new AppError(400, "invalid_month", "Month must be written YYYY-MM.");
  const rows = db.all<CalendarRow>(sql`
    select t.date as date, a.id as account_id, a.name as name, a.color as color,
      count(*) as n, sum(t.pending) as pending,
      sum(case when t.amount_minor > 0 then t.amount_minor else 0 end) as outflow,
      -sum(case when t.amount_minor < 0 then t.amount_minor else 0 end) as inflow
    ${fromTransactions}
    where ${whereClauses({
      from: firstOfMonth(month),
      to: lastOfMonth(month),
      accountId,
      category: undefined,
      includeTransfers: true,
      includePending: true,
      environment,
    })}
    group by t.date, a.id
    order by t.date, a.id
  `);

  const days = new Map<string, CalendarDay>();
  for (const r of rows) {
    const day = days.get(r.date) ?? {
      date: r.date,
      count: 0,
      pendingCount: 0,
      outflowMinor: 0,
      inflowMinor: 0,
      accounts: [],
    };
    day.count += r.n;
    day.pendingCount += r.pending ?? 0;
    day.outflowMinor += r.outflow ?? 0;
    day.inflowMinor += r.inflow ?? 0;
    day.accounts.push({
      accountId: r.account_id,
      name: r.name,
      color: r.color,
      count: r.n,
      outflowMinor: r.outflow ?? 0,
      inflowMinor: r.inflow ?? 0,
    });
    days.set(r.date, day);
  }
  return { month, days: [...days.values()] };
}

// ---- Overview (balances and net worth) ---------------------------------------------------

export interface CreditCardOverview {
  accountId: number;
  name: string;
  color: string | null;
  institutionName: string | null;
  balanceMinor: number | null;
  limitMinor: number | null;
  utilizationPercent: number | null;
  lastLimitChange: {
    effectiveDate: string;
    changeMinor: number;
    changePercent: number | null;
    source: string;
  } | null;
}

export interface Overview {
  currency: string;
  cashMinor: number;
  investmentsMinor: number;
  otherAssetsMinor: number;
  assetsMinor: number;
  creditDebtMinor: number;
  loanDebtMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  coverage: {
    accountsCounted: number;
    accountsWithoutBalance: number;
    /** Accounts in another currency are left out rather than added up wrongly. */
    accountsOtherCurrency: number;
    oldestBalanceAt: string | null;
    newestBalanceAt: string | null;
  };
  creditCards: CreditCardOverview[];
}

/** Current balances rolled up into assets, debts, and net worth, with a note of how complete they are. */
export function overview(db: AppDb): Overview {
  const settings = getSettings(db);
  const currency = settings.currency;
  const all = listAccounts(db).filter(
    (a) => a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment,
  );

  const totals = { cash: 0, investments: 0, otherAssets: 0, credit: 0, loan: 0 };
  let counted = 0;
  let withoutBalance = 0;
  let otherCurrency = 0;
  const stamps: string[] = [];

  for (const account of all) {
    if (account.currency !== currency) {
      otherCurrency += 1;
      continue;
    }
    if (account.currentBalanceMinor === null) {
      withoutBalance += 1;
      continue;
    }
    counted += 1;
    if (account.lastBalanceUpdateAt) stamps.push(account.lastBalanceUpdateAt);
    const balance = account.currentBalanceMinor;
    switch (account.type) {
      case "depository":
        totals.cash += balance;
        break;
      case "investment":
      case "brokerage":
        totals.investments += balance;
        break;
      case "credit":
        totals.credit += balance; // the amount owed, shown as a positive number
        break;
      case "loan":
        totals.loan += balance;
        break;
      default:
        totals.otherAssets += balance;
    }
  }
  stamps.sort();

  const assets = totals.cash + totals.investments + totals.otherAssets;
  const liabilities = totals.credit + totals.loan;

  const creditCards: CreditCardOverview[] = all
    .filter((a) => a.type === "credit")
    .map((a) => {
      const entries = creditLimitHistoryFor(db, a.id);
      const last = entries.find((e) => e.changeMinor !== null);
      return {
        accountId: a.id,
        name: a.name,
        color: a.color,
        institutionName: a.institutionName,
        balanceMinor: a.currentBalanceMinor,
        limitMinor: a.creditLimitMinor,
        utilizationPercent:
          a.creditLimitMinor && a.currentBalanceMinor !== null
            ? Math.round((a.currentBalanceMinor / a.creditLimitMinor) * 100)
            : null,
        lastLimitChange: last
          ? {
              effectiveDate: last.effectiveDate,
              changeMinor: last.changeMinor!,
              changePercent: last.changePercent,
              source: last.source,
            }
          : null,
      };
    });

  return {
    currency,
    cashMinor: totals.cash,
    investmentsMinor: totals.investments,
    otherAssetsMinor: totals.otherAssets,
    assetsMinor: assets,
    creditDebtMinor: totals.credit,
    loanDebtMinor: totals.loan,
    liabilitiesMinor: liabilities,
    netWorthMinor: assets - liabilities,
    coverage: {
      accountsCounted: counted,
      accountsWithoutBalance: withoutBalance,
      accountsOtherCurrency: otherCurrency,
      oldestBalanceAt: stamps[0] ?? null,
      newestBalanceAt: stamps.at(-1) ?? null,
    },
    creditCards,
  };
}
