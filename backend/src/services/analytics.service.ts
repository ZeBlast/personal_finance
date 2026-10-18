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
import { accountScope, countsInNetWorth, STORE_CREDIT_SUBTYPE } from "./account-scope.js";

/**
 * What "spending" and "income" mean in every chart and budget (one definition, used everywhere):
 *
 * - Only transfers between your OWN accounts are left out by default (see transfer.service.ts: they
 *   are found by matching, or marked by the user), along with credit-card payments, which would
 *   otherwise count the same money twice (once when spent on the card, again when the card was
 *   paid). Money sent to or received from another person (a Zelle, rent to a landlord) counts.
 * - **Income** is money in that is categorized as income (by the bank, or by a category named
 *   "Income") or that another person sent (a transfer-in, or a transaction with a sender).
 *   Everything else is **spending**.
 * - Refunds are negative spending: a refund reduces the spending of its category rather than
 *   counting as income, so a returned purchase nets out.
 * - Pending transactions are included unless asked otherwise.
 */
export const IS_INCOME = sql`(t.refund_of_id is null and coalesce(c.income_treatment, '') <> 'refund' and (
  (c.income_treatment = 'income' and t.amount_minor < 0)
  or t.plaid_category_primary = 'INCOME'
  or lower(coalesce(c.name, '')) = 'income'
  or (t.amount_minor < 0 and (t.plaid_category_primary = 'TRANSFER_IN'
    or coalesce(nullif(trim(t.sender_user), ''), nullif(trim(t.sender), '')) is not null))))`;
/**
 * Not money moving between accounts. Besides transfers and the bank's own "credit card payment"
 * category, this leaves out any loan payment that sits on a credit card account: that is a payment
 * TO the card (found against Plaid Sandbox, which labels card payments "other payment" instead).
 * A loan payment on a checking account, such as a mortgage, still counts as spending.
 */
export const NOT_TRANSFER = sql`(t.is_transfer = 0
  and coalesce(t.plaid_category_detailed, '') <> 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
  and not (a.type = 'credit' and coalesce(t.plaid_category_primary, '') = 'LOAN_PAYMENTS'))`;
/**
 * Payments toward debt, which the calendar shows apart from spending: they lower what is owed.
 *
 * - `debt`: money arriving on a credit card or loan account that pays it down (not a refund: that
 *   has to be flagged as a transfer, come with a loan-payment or transfer category, or read like a
 *   payment).
 * - `funding`: the matching money leaving the account that paid (it is the same payment, so it is
 *   not counted again).
 * - `funding_unpaired`: a card payment leaving an account when the card itself is not tracked.
 */
const DEBT_NAME = sql`((lower(t.name) like '%payment%' or lower(t.name) like '%autopay%'
  or lower(t.name) like '%pmt%' or lower(t.name) like '%thank you%')
  and not (lower(t.name) like '%cashback%' or lower(t.name) like '%cash back%'
    or lower(t.name) like '%reward%' or lower(t.name) like '%refund%'
    or lower(t.name) like '%promo%' or lower(t.name) like '%statement credit%'
    or lower(t.name) like '%credit thank you%' or lower(t.name) like '%adjustment%'
    or lower(t.name) like '%benefit%' or lower(t.name) like '%claim%'
    or lower(t.name) like '%protection%'
    or coalesce(t.plaid_category_primary, '') like 'INCOME%'))`;

/** The other side of this transaction's transfer is a visible card or loan / another kind of account. */
const PAIRED_WITH_DEBT = sql`exists (select 1 from transactions pt join accounts pa on pa.id = pt.account_id
    where pt.id = t.transfer_pair_id and pa.type in ('credit', 'loan') and pa.hidden = 0)`;
const PAIRED_WITH_CASH = sql`exists (select 1 from transactions pt join accounts pa on pa.id = pt.account_id
    where pt.id = t.transfer_pair_id and pa.type not in ('credit', 'loan') and pa.hidden = 0)`;
/**
 * What a transaction is toward debt:
 * - `debt`: a payment into a card or loan with no matched paying side (counted as debt paid here).
 * - `debt_paired`: a payment into a card or loan matched with the money that paid it. Not counted
 *   here: the paying side (`funding`) counts it, on the day that money left.
 * - `funding`: money that left another account to pay a card or loan (counted as debt paid).
 * - `funding_unpaired`: looks like a card payment, but no card is tracked to match it with.
 */
export const DEBT_KIND = sql`(case
  when a.type in ('credit', 'loan') and t.amount_minor < 0 and (a.type = 'loan' or t.is_transfer = 1
    or coalesce(t.plaid_category_primary, '') like 'LOAN_PAYMENTS%'
    or coalesce(t.plaid_category_primary, '') = 'TRANSFER_IN' or ${DEBT_NAME})
    then (case when ${PAIRED_WITH_CASH} then 'debt_paired' else 'debt' end)
  when a.type not in ('credit', 'loan') and t.amount_minor > 0 and ${PAIRED_WITH_DEBT}
    then 'funding'
  when a.type not in ('credit', 'loan') and t.amount_minor > 0
    and coalesce(t.plaid_category_detailed, '') = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    then 'funding_unpaired'
  end)`;

/**
 * Debt paid, summed. A matched card payment counts once, on the day the paying account's money left
 * (`funding`). When only one account is in view, the other side is not there to count it, so the
 * card's own side (`debt_paired`) counts instead.
 */
export function debtPaidSum(oneAccount: boolean): SQL {
  return oneAccount
    ? sql`sum(case when ${DEBT_KIND} in ('debt', 'debt_paired') then -t.amount_minor when ${DEBT_KIND} = 'funding' then t.amount_minor else 0 end)`
    : sql`sum(case ${DEBT_KIND} when 'debt' then -t.amount_minor when 'funding' then t.amount_minor else 0 end)`;
}

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

/**
 * Which date a transaction is placed on: `transaction` is when it was made (the authorized date,
 * or the posted date when the bank gives no other), `posted` is when it cleared.
 */
export type DateBasis = "transaction" | "posted";
export const DATE_BASES = ["transaction", "posted"] as const;

/**
 * The SQL date of a transaction (alias `t`) on a basis. Charts and summaries default to the
 * transaction date, so a purchase counts in the day, week or month it was made in.
 */
export function dateOf(basis: DateBasis | undefined): SQL {
  return basis === "posted" ? sql`t.date` : sql`coalesce(t.authorized_date, t.date)`;
}

export interface SummaryQuery {
  /** Which date places a transaction in the period and its day/week/month (default: transaction). */
  dateBasis?: DateBasis | undefined;
  from: string;
  to: string;
  groupBy: Group;
  accountId?: number | undefined;
  /** Only one bank's accounts: its name as the connection shows it, or "manual" for hand-kept. */
  institution?: string | undefined;
  /** A category ID (including its subcategories) or "none" for uncategorized. */
  category?: number | "none" | undefined;
  /** Only merchants whose shown name contains this (any case). */
  merchant?: string | undefined;
  /** Only transactions with this tag. */
  tagId?: number | undefined;
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

/** `day` is the transaction's date on the query's basis, the same one that places it in the period. */
function groupSql(group: Group, rollup: boolean, day: SQL): GroupSql {
  switch (group) {
    case "none":
      return { key: sql`'all'`, label: sql`'All'`, color: sql`null` };
    case "day":
      return { key: day, label: day, color: sql`null` };
    case "week":
      return {
        key: sql`date(${day}, 'weekday 0', '-6 days')`,
        label: sql`date(${day}, 'weekday 0', '-6 days')`,
        color: sql`null`,
      };
    case "month":
      return { key: sql`substr(${day}, 1, 7)`, label: sql`substr(${day}, 1, 7)`, color: sql`null` };
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
    | "from"
    | "to"
    | "accountId"
    | "institution"
    | "category"
    | "merchant"
    | "tagId"
    | "includeTransfers"
    | "includePending"
    | "environment"
    | "dateBasis"
  >,
): SQL {
  const day = dateOf(q.dateBasis);
  const parts: SQL[] = [
    sql`${day} >= ${q.from}`,
    sql`${day} <= ${q.to}`,
    sql`(p.environment = ${q.environment} or a.plaid_item_id is null)`,
    accountScope(q.accountId),
  ];
  if (q.accountId !== undefined) parts.push(sql`t.account_id = ${q.accountId}`);
  if (q.institution === "manual") parts.push(sql`a.plaid_item_id is null`);
  else if (q.institution !== undefined) parts.push(sql`p.institution_name = ${q.institution}`);
  if (q.category === "none") parts.push(sql`t.category_id is null`);
  else if (q.category !== undefined) {
    parts.push(sql`(t.category_id = ${q.category} or c.parent_id = ${q.category})`);
  }
  if (q.merchant !== undefined && q.merchant.trim() !== "") {
    const like = `%${q.merchant
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    parts.push(
      sql`lower(coalesce(t.merchant_name_user, t.merchant_name, t.name)) like ${like} escape '\\'`,
    );
  }
  if (q.tagId !== undefined) {
    parts.push(
      sql`exists (select 1 from transaction_tags tt where tt.transaction_id = t.id and tt.tag_id = ${q.tagId})`,
    );
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

/**
 * Transactions as totals count them: `transaction_lines` is each transaction, or each part of a
 * split one in its own category (see transactionSplits). Counts use `count(distinct t.id)` so a
 * split transaction is still one transaction.
 */
const fromTransactions = sql`from transaction_lines t
  join accounts a on a.id = t.account_id
  left join plaid_items p on p.id = a.plaid_item_id
  left join categories c on c.id = t.category_id`;

/** Spending and income for any period, grouped any of the ways above. This one query feeds most widgets. */
export function summarize(db: AppDb, q: SummaryQuery): Summary {
  validateRange(q.from, q.to, q.groupBy);
  const g = groupSql(q.groupBy, q.rollupToParent ?? false, dateOf(q.dateBasis));
  const raw = db.all<RawRow>(sql`
    select ${g.key} as key, max(${g.label}) as label, max(${g.color}) as color,
      sum(case when ${IS_INCOME} then 0 else t.amount_minor end) as spending,
      -sum(case when ${IS_INCOME} then t.amount_minor else 0 end) as income,
      count(distinct t.id) as n
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
  /**
   * Money that left your accounts that day, and money that came in. Moves between your own accounts
   * and payments toward debt are not in these: they are not money coming in or going out.
   */
  outflowMinor: number;
  inflowMinor: number;
  /** Payments toward credit cards and loans, which lower what you owe. Not in the two above. */
  debtPaidMinor: number;
  accounts: Array<{
    accountId: number;
    name: string;
    color: string | null;
    count: number;
    outflowMinor: number;
    inflowMinor: number;
    debtPaidMinor: number;
    /** The day's net effect on the account, as money: purchases negative, money in positive. */
    changeMinor: number;
    institutionName: string | null;
    /** The connection the account belongs to (null for an account kept by hand). */
    itemId: number | null;
  }>;
  /** The kinds of transactions that day: one entry per category (null for uncategorized). */
  categories: Array<{
    categoryId: number | null;
    name: string;
    color: string | null;
    count: number;
  }>;
}

interface CalendarRow {
  date: string;
  account_id: number;
  name: string;
  color: string | null;
  institution: string | null;
  item_id: number | null;
  change: number | null;
  n: number;
  pending: number;
  outflow: number | null;
  inflow: number | null;
  debt: number | null;
  funding: number | null;
}

/** Whether any credit card or loan account is tracked (so payments can be seen from its side). */
export function debtAccountsTracked(db: AppDb): boolean {
  return (
    db.get<{ n: number }>(
      sql`select count(*) as n from accounts where type in ('credit', 'loan') and hidden = 0`,
    )?.n !== 0
  );
}

/** What happened on each day of a month, and on which account. Days with nothing are omitted. */
export function calendarMonth(
  db: AppDb,
  month: string,
  environment: string,
  accountId?: number,
  dateBasis: DateBasis = "transaction",
): { month: string; days: CalendarDay[] } {
  if (!isRealMonth(month))
    throw new AppError(400, "invalid_month", "Month must be written YYYY-MM.");
  const rows = db.all<CalendarRow>(sql`
    select ${dateOf(dateBasis)} as date, a.id as account_id, a.name as name, a.color as color,
      p.institution_name as institution, a.plaid_item_id as item_id, -sum(t.amount_minor) as change,
      count(distinct t.id) as n,
      count(distinct case when t.pending = 1 then t.id end) as pending,
      sum(case when t.amount_minor > 0 and ${DEBT_KIND} is null and t.is_transfer = 0 then t.amount_minor else 0 end) as outflow,
      -sum(case when t.amount_minor < 0 and ${DEBT_KIND} is null and t.is_transfer = 0 then t.amount_minor else 0 end) as inflow,
      ${debtPaidSum(accountId !== undefined)} as debt,
      sum(case when ${DEBT_KIND} = 'funding_unpaired' then t.amount_minor else 0 end) as funding
    ${fromTransactions}
    where ${whereClauses({
      from: firstOfMonth(month),
      to: lastOfMonth(month),
      accountId,
      category: undefined,
      includeTransfers: true,
      includePending: true,
      environment,
      dateBasis,
    })}
    group by 1, a.id
    order by 1, a.id
  `);

  // A card payment seen only from the paying side counts as debt paid only when no card or loan is
  // tracked; otherwise the card's own side already counts it.
  const cardsTracked = debtAccountsTracked(db);
  const days = new Map<string, CalendarDay>();
  for (const r of rows) {
    const day = days.get(r.date) ?? {
      date: r.date,
      count: 0,
      pendingCount: 0,
      outflowMinor: 0,
      inflowMinor: 0,
      debtPaidMinor: 0,
      accounts: [],
      categories: [],
    };
    const debtPaid = (r.debt ?? 0) + (cardsTracked ? 0 : (r.funding ?? 0));
    day.count += r.n;
    day.pendingCount += r.pending ?? 0;
    day.outflowMinor += r.outflow ?? 0;
    day.inflowMinor += r.inflow ?? 0;
    day.debtPaidMinor += debtPaid;
    day.accounts.push({
      accountId: r.account_id,
      name: r.name,
      color: r.color,
      count: r.n,
      outflowMinor: r.outflow ?? 0,
      inflowMinor: r.inflow ?? 0,
      debtPaidMinor: debtPaid,
      changeMinor: r.change ?? 0,
      institutionName: r.institution,
      itemId: r.item_id,
    });
    days.set(r.date, day);
  }

  // The kinds of transactions on each day, most frequent first.
  const kinds = db.all<{
    date: string;
    category_id: number | null;
    name: string | null;
    color: string | null;
    n: number;
  }>(sql`
    select ${dateOf(dateBasis)} as date, t.category_id as category_id, c.name as name,
      c.color as color, count(*) as n
    ${fromTransactions}
    where ${whereClauses({
      from: firstOfMonth(month),
      to: lastOfMonth(month),
      accountId,
      category: undefined,
      includeTransfers: true,
      includePending: true,
      environment,
      dateBasis,
    })}
    group by 1, t.category_id
    order by 1, n desc, c.name`);
  for (const k of kinds) {
    days.get(k.date)?.categories.push({
      categoryId: k.category_id,
      name: k.name ?? "Uncategorized",
      color: k.color,
      count: k.n,
    });
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
    (a) =>
      countsInNetWorth(a) &&
      (a.itemId === null || a.connectionEnvironment === settings.plaidEnvironment),
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
    // Gift card credits are worth their dollars, but are not cash you can spend anywhere.
    if (account.subtype === STORE_CREDIT_SUBTYPE) {
      totals.otherAssets += balance;
      continue;
    }
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
