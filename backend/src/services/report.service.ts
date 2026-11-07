import { sql } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { addMonths, firstOfMonth, isRealMonth, lastOfMonth } from "../utils/dates.js";
import { AppError } from "../utils/errors.js";
import { NOT_TRANSFER, summarize } from "./analytics.service.js";
import { budgetMonth, type CapHistoryPoint, type CapStatus } from "./budget.service.js";
import { periodSummary } from "./calendar.service.js";
import { cashbackSummary } from "./cashback.service.js";
import { netWorthHistory } from "./networth-history.service.js";
import { getSettings } from "./settings.service.js";
import { countedAccount } from "./account-scope.js";

/**
 * The month-end report: one page on how a month went, compared with the month before. Spending and
 * income leave out moves between the user's own accounts and card payments, as everywhere else.
 */

export interface MonthReport {
  month: string;
  currency: string;
  incomeMinor: number;
  spendingMinor: number;
  /** Income minus spending. */
  savedMinor: number;
  /** Saved as a share of income (null without income). */
  savingsRatePercent: number | null;
  previous: { incomeMinor: number; spendingMinor: number; savedMinor: number };
  /** Spending by category, with last month's, biggest changes first. */
  categories: Array<{
    label: string;
    color: string | null;
    spendingMinor: number;
    previousMinor: number;
    changeMinor: number;
  }>;
  /** The largest purchases of the month. */
  largest: Array<{
    id: number;
    date: string;
    merchant: string;
    amountMinor: number;
    accountName: string;
  }>;
  budgets: {
    count: number;
    overspent: number;
    budgetedMinor: number;
    spentMinor: number;
    /** Each cap that month: over first, then the closest to it. */
    items: Array<{
      categoryId: number;
      label: string;
      color: string | null;
      capMinor: number;
      spentMinor: number;
      remainingMinor: number;
      percentUsed: number;
      status: CapStatus;
      history: CapHistoryPoint[];
    }>;
  };
  debtPaidMinor: number;
  cashbackMinor: number;
  netWorth: { startMinor: number | null; endMinor: number | null; changeMinor: number | null };
  transactionCount: number;
}

export function monthReport(db: AppDb, month: string): MonthReport {
  if (!isRealMonth(month))
    throw new AppError(400, "invalid_month", "Month must be written YYYY-MM.");
  const settings = getSettings(db);
  const environment = settings.plaidEnvironment;
  const from = firstOfMonth(month);
  const to = lastOfMonth(month);
  const prev = addMonths(month, -1);
  const base = {
    includeTransfers: false,
    includePending: true,
    fill: false,
    environment,
  };
  const now = summarize(db, { ...base, from, to, groupBy: "category" });
  const before = summarize(db, {
    ...base,
    from: firstOfMonth(prev),
    to: lastOfMonth(prev),
    groupBy: "category",
  });

  const prevByLabel = new Map(before.rows.map((r) => [r.label, r.spendingMinor]));
  const labels = new Set([...now.rows.map((r) => r.label), ...before.rows.map((r) => r.label)]);
  const categories = [...labels]
    .map((label) => {
      const row = now.rows.find((r) => r.label === label);
      const spending = row?.spendingMinor ?? 0;
      const previous = prevByLabel.get(label) ?? 0;
      return {
        label,
        color: row?.color ?? before.rows.find((r) => r.label === label)?.color ?? null,
        spendingMinor: spending,
        previousMinor: previous,
        changeMinor: spending - previous,
      };
    })
    .filter((c) => c.spendingMinor > 0 || c.previousMinor > 0)
    .sort((a, b) => Math.abs(b.changeMinor) - Math.abs(a.changeMinor));

  const largest = db.all<{
    id: number;
    date: string;
    merchant: string;
    amountMinor: number;
    accountName: string;
  }>(sql`
    select id, date, merchant, amountMinor, accountName from (
      select t.id as id, coalesce(t.authorized_date, t.date) as date,
        coalesce(nullif(trim(t.merchant_name_user), ''), t.merchant_name, t.name) as merchant,
        -- What the purchase cost once its linked refunds came back, as spending counts it.
        t.amount_minor + coalesce((select sum(r.amount_minor) from transactions r
          where r.refund_of_id = t.id), 0) as amountMinor,
        a.name as accountName
      from transactions t
        join accounts a on a.id = t.account_id
        left join plaid_items p on p.id = a.plaid_item_id
      where coalesce(t.authorized_date, t.date) between ${from} and ${to}
        and t.amount_minor > 0 and ${countedAccount()}
        and (p.environment = ${environment} or a.plaid_item_id is null)
        and a.type <> 'investment'
        and ${NOT_TRANSFER}
    )
    -- A purchase refunded in full cost nothing, so it is not among the largest.
    where amountMinor > 0
    order by amountMinor desc limit 5`);

  const budgets = budgetMonth(db, month, environment, { detail: true });
  const period = periodSummary(db, from, to, undefined, environment, undefined, "posted");
  const cashback = cashbackSummary(db, { from, to });

  const points = netWorthHistory(db, { from: addMonths(month, -1) + "-01", to }).points;
  const at = (day: string): number | null => {
    const candidates = points.filter((p) => p.date <= day);
    return candidates.length ? candidates[candidates.length - 1]!.netWorthMinor : null;
  };
  const startNw = at(lastOfMonth(prev));
  const endNw = at(to);

  const income = now.totals.incomeMinor;
  const spending = now.totals.spendingMinor;
  return {
    month,
    currency: settings.currency,
    incomeMinor: income,
    spendingMinor: spending,
    savedMinor: income - spending,
    savingsRatePercent: income > 0 ? Math.round(((income - spending) / income) * 1000) / 10 : null,
    previous: {
      incomeMinor: before.totals.incomeMinor,
      spendingMinor: before.totals.spendingMinor,
      savedMinor: before.totals.incomeMinor - before.totals.spendingMinor,
    },
    categories,
    largest,
    budgets: {
      count: budgets.budgets.length,
      overspent: budgets.budgets.filter((b) => b.overspent).length,
      budgetedMinor: budgets.totals.budgetedMinor,
      spentMinor: budgets.totals.spentMinor,
      items: budgets.budgets
        .map((b) => ({
          categoryId: b.categoryId,
          label: b.categoryName,
          color: b.categoryColor,
          capMinor: b.availableMinor,
          spentMinor: b.spentMinor,
          remainingMinor: b.remainingMinor,
          percentUsed: b.percentUsed,
          status: b.status,
          history: b.history ?? [],
        }))
        .sort((a, b) => b.percentUsed - a.percentUsed),
    },
    debtPaidMinor: period.debtPaidMinor,
    cashbackMinor: cashback.totalCashbackMinor,
    netWorth: {
      startMinor: startNw,
      endMinor: endNw,
      changeMinor: startNw !== null && endNw !== null ? endNw - startNw : null,
    },
    transactionCount: now.totals.count,
  };
}
