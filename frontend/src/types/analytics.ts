export type SummaryGroup =
  "none" | "day" | "week" | "month" | "category" | "merchant" | "account" | "institution";

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
  groupBy: SummaryGroup;
  rows: SummaryRow[];
  totals: Omit<SummaryRow, "key" | "label" | "color">;
}

export interface CalendarDay {
  date: string;
  count: number;
  pendingCount: number;
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

export interface CalendarMonth {
  month: string;
  days: CalendarDay[];
}

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
    accountsOtherCurrency: number;
    oldestBalanceAt: string | null;
    newestBalanceAt: string | null;
  };
  creditCards: CreditCardOverview[];
}

export interface Budget {
  id: number;
  categoryId: number;
  categoryName: string;
  categoryColor: string | null;
  parentId: number | null;
  amountMinor: number;
  spentMinor: number;
  remainingMinor: number;
  percentUsed: number;
  overspent: boolean;
}

export interface BudgetMonth {
  month: string;
  budgets: Budget[];
  totals: { budgetedMinor: number; spentMinor: number; remainingMinor: number };
  unbudgetedSpendingMinor: number;
}

export interface SavedWidget {
  id: number;
  widgetType: string;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}

export interface DashboardLayout {
  dashboardId: number;
  initialized: boolean;
  widgets: SavedWidget[];
}

export interface DashboardSummary {
  id: number;
  name: string;
  widgetCount: number;
}

export interface DashboardList {
  active: number;
  dashboards: DashboardSummary[];
}
