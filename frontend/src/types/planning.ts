import type { Transaction } from "./api";

/** Shapes returned by backend/src/routes/planning.routes.ts. */

export interface ForecastEvent {
  label: string;
  amountMinor: number;
  source: "expected" | "recurring" | "card_bill" | "pending" | "debt_plan";
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

/** Something about a recurring charge worth a look. */
export interface RecurringChange {
  key: string;
  merchant: string;
  kind: "price_up" | "price_down" | "new" | "charged_after_cancel";
  date: string;
  fromMinor: number | null;
  toMinor: number;
  yearlyDeltaMinor: number;
}

/** Regular pay found in the income. */
export interface Paycheck {
  key: string;
  source: string;
  cadence: "weekly" | "biweekly" | "semimonthly" | "monthly";
  typicalMinor: number;
  lastDate: string;
  lastAmountMinor: number;
  nextExpected: string;
  occurrences: number;
  accountName: string;
  receivedThisYearMinor: number;
  paydaysLeft: number;
  projectedYearMinor: number;
  active: boolean;
}

export interface SubscriptionReview {
  currency: string;
  subscriptions: Subscription[];
  changes: RecurringChange[];
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

export type SubscriptionBilling = "recurring" | "installments" | "prepaid";
export type SubscriptionFrequency = "weekly" | "monthly" | "yearly";

/** A subscription the user keeps track of (see the backend's tracked-subscriptions service). */
export interface TrackedSubscription {
  id: number;
  name: string;
  /** What each charge costs, in cents. */
  amountMinor: number;
  billing: SubscriptionBilling;
  frequency: SubscriptionFrequency | null;
  repeatEvery: number;
  startDate: string;
  termMonths: number | null;
  accountId: number | null;
  accountName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  email: string | null;
  username: string | null;
  website: string | null;
  notes: string | null;
  status: "active" | "cancelled";
  cancelledOn: string | null;
  recurringKey: string | null;
  /** When a free trial ends. */
  trialEndsOn: string | null;
  /** What its payments' merchant contains; null uses the found series or the name. */
  paymentMatch: string | null;
  onCalendar: boolean;
  nextCharge: string | null;
  endDate: string | null;
  chargesLeft: number | null;
  monthlyMinor: number;
  ended: boolean;
}

export interface TrackedSubscriptionList {
  subscriptions: TrackedSubscription[];
  totals: { monthlyMinor: number; yearlyMinor: number; active: number };
}

/** A tracked subscription's payments over time, newest first. */
export interface PaymentHistory {
  subscriptionId: number;
  /** What the merchant was matched against, and where that came from. */
  match: string;
  matchSource: "set" | "found" | "name";
  payments: Array<{
    id: number;
    date: string;
    merchant: string;
    accountName: string;
    amountMinor: number;
    /** The user said this one is not a payment of the subscription. */
    excluded: boolean;
    /** The amount differs from the payment before. */
    changeMinor: number | null;
  }>;
  totalMinor: number;
}

/** Something coming up: a trial ending, a yearly renewal, a plan ending, or a price rise. */
export interface RenewalItem {
  key: string;
  kind: "trial" | "renewal" | "ending" | "price" | "yearly_charge";
  title: string;
  detail: string;
  date: string;
  amountMinor: number | null;
  changeMinor?: number;
  subscriptionId: number | null;
}
