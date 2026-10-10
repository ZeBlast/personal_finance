/** What the calendar endpoints return (see backend/src/services/calendar.service.ts). */

export interface DayNote {
  date: string;
  note: string;
  updatedAt: string;
}

export interface CalendarOverlay {
  month: string;
  notes: Record<string, string>;
  expected: Array<{ date: string; count: number; outflowMinor: number; inflowMinor: number }>;
}

export interface PeriodSummary {
  from: string;
  to: string;
  currency: string;
  balance: {
    startMinor: number | null;
    endMinor: number | null;
    changeMinor: number | null;
    /** The period reaches past today, so the end balance includes expected transactions. */
    projected: boolean;
    accountsCounted: number;
    accountsWithoutBalance: number;
  };
  /** What is owed on credit cards and loans. */
  debt: {
    startMinor: number | null;
    endMinor: number | null;
    /** Negative when the debt went down. */
    changeMinor: number | null;
    accountsCounted: number;
  };
  /** Payments toward credit cards and loans: they lower the debt and are not spending. */
  debtPaidMinor: number;
  moneyInMinor: number;
  moneyOutMinor: number;
  transactionCount: number;
  pendingCount: number;
  spendingMinor: number;
  incomeMinor: number;
  topCategories: Array<{ label: string; color: string | null; spendingMinor: number }>;
  expected: { count: number; outflowMinor: number; inflowMinor: number };
  notes: DayNote[];
}

export type Frequency = "once" | "daily" | "weekly" | "monthly" | "yearly";

export interface PlannedItem {
  id: number;
  merchant: string;
  /** Always positive. */
  amountMinor: number;
  direction: "out" | "in";
  accountId: number | null;
  accountName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  person: string | null;
  notes: string | null;
  startDate: string;
  frequency: Frequency;
  repeatEvery: number;
  weekdays: number[];
  monthMode: "day" | "weekday" | null;
  dayOfMonth: number | null;
  nthWeek: number | null;
  endDate: string | null;
  maxCount: number | null;
  repeats: string;
  nextDate: string | null;
}

export interface PlannedOccurrence {
  plannedId: number;
  date: string;
  merchant: string;
  amountMinor: number;
  direction: "out" | "in";
  accountId: number | null;
  accountName: string | null;
  accountType: string | null;
  categoryName: string | null;
  person: string | null;
  repeats: string;
  recurring: boolean;
  canRecord: boolean;
  status: "expected" | "skipped" | "done";
}
