/** What the calendar endpoints return (see backend/src/services/calendar.service.ts). */

export interface DayNote {
  date: string;
  note: string;
  updatedAt: string;
}

export interface CalendarOverlay {
  month: string;
  notes: Record<string, string>;
  expected: Array<{
    date: string;
    count: number;
    outflowMinor: number;
    inflowMinor: number;
    /** The day's expected items, largest first. */
    items: Array<{
      merchant: string;
      amountMinor: number;
      direction: "out" | "in";
      source: "planned" | "pending";
    }>;
  }>;
}

/**
 * Something still expected: an occurrence of a planned transaction, or a manual entry still
 * pending (projected onto the day it can take effect). One list feeds the grid, the totals and
 * the Expected tab.
 */
export interface CalendarEvent {
  id: string;
  source: "planned" | "pending";
  /** Due (planned) or projected (pending). */
  date: string;
  /** The date it was entered with; later than `date` never, earlier when carried forward. */
  originalDate: string;
  merchant: string;
  amountMinor: number;
  direction: "out" | "in";
  accountId: number | null;
  accountName: string | null;
  accountType: string | null;
  categoryName: string | null;
  status: "expected" | "skipped" | "done";
  plannedId: number | null;
  person: string | null;
  repeats: string | null;
  recurring: boolean;
  canRecord: boolean;
  transactionId: number | null;
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
    /** Cash accounts on their own (null when none is counted). */
    cash: { startMinor: number | null; endMinor: number | null };
    /** Owed on the counted cards (null when none is counted). Cash minus this is the total. */
    cardDebt: { startMinor: number | null; endMinor: number | null };
    /** For a projected end: the balance today and the expected money in and out after it. */
    projection: { todayMinor: number; inMinor: number; outMinor: number } | null;
    accounts: Array<{ name: string; type: string }>;
    withoutBalance: Array<{ name: string; type: string }>;
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
