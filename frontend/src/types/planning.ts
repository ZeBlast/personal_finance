import type { Transaction } from "./api";

/** Shapes returned by backend/src/routes/planning.routes.ts. */

export interface ForecastEvent {
  label: string;
  amountMinor: number;
  source: "expected" | "recurring" | "card_bill";
}

export interface Forecast {
  currency: string;
  today: string;
  startBalanceMinor: number;
  accountsCounted: number;
  days: Array<{ date: string; balanceMinor: number; changeMinor: number; events: ForecastEvent[] }>;
  lowest: { date: string; balanceMinor: number };
  endBalanceMinor: number;
}

export type BillStatus = "paid" | "partial" | "due" | "overdue" | "nothing_due";

export interface CardBill {
  accountId: number;
  name: string;
  institutionName: string | null;
  color: string | null;
  currency: string;
  currentBalanceMinor: number | null;
  settings: {
    closingDay: number;
    dueDay: number;
    minimumMinor: number | null;
    autopay: boolean;
  } | null;
  statement: {
    closedOn: string;
    dueOn: string;
    balanceMinor: number;
    paidMinor: number;
    remainingMinor: number;
    minimumMinor: number | null;
    status: BillStatus;
    daysUntilDue: number;
  } | null;
  next: { closesOn: string; dueOn: string; balanceSoFarMinor: number } | null;
}

export type SubscriptionStatus = "keep" | "cancel" | "cancelled";

export interface Subscription {
  key: string;
  merchant: string;
  cadence: string;
  typicalAmountMinor: number;
  lastAmountMinor: number;
  amountVaries: boolean;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextExpected: string;
  status: "active" | "lapsed";
  perMonthMinor: number;
  yearlyMinor: number;
  accountNames: string[];
  priceChange: { fromMinor: number; toMinor: number; date: string } | null;
  review: { status: SubscriptionStatus; note: string | null } | null;
  chargedAfterCancel: boolean;
}

export interface SubscriptionReview {
  currency: string;
  subscriptions: Subscription[];
  totals: { monthlyMinor: number; yearlyMinor: number; toCancelYearlyMinor: number };
}

export interface MonthReport {
  month: string;
  currency: string;
  incomeMinor: number;
  spendingMinor: number;
  savedMinor: number;
  savingsRatePercent: number | null;
  previous: { incomeMinor: number; spendingMinor: number; savedMinor: number };
  categories: Array<{
    label: string;
    color: string | null;
    spendingMinor: number;
    previousMinor: number;
    changeMinor: number;
  }>;
  largest: Array<{
    id: number;
    date: string;
    merchant: string;
    amountMinor: number;
    accountName: string;
  }>;
  budgets: { count: number; overspent: number; budgetedMinor: number; spentMinor: number };
  debtPaidMinor: number;
  cashbackMinor: number;
  netWorth: { startMinor: number | null; endMinor: number | null; changeMinor: number | null };
  transactionCount: number;
}

export interface Attachment {
  id: number;
  transactionId: number;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export type ReviewReason =
  "uncategorized" | "new_merchant" | "unusual_amount" | "large" | "duplicate";

export interface ReviewQueue {
  items: Array<{ transaction: Transaction; reasons: ReviewReason[] }>;
  counts: Record<ReviewReason, number>;
  windowDays: number;
}

export interface DuplicatePair {
  key: string;
  transactions: [Transaction, Transaction];
}
