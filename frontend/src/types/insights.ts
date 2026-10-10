/** Shapes returned by the /api/insights endpoints. Money is whole minor units (cents). */

export type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "yearly";
export type Direction = "out" | "in";

export interface RecurringSeries {
  key: string;
  merchant: string;
  direction: Direction;
  cadence: Cadence;
  typicalAmountMinor: number;
  lastAmountMinor: number;
  amountVaries: boolean;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextExpected: string;
  status: "active" | "lapsed";
  perMonthMinor: number;
  accountNames: string[];
  priceChange: { fromMinor: number; toMinor: number; date: string } | null;
  dismissed: boolean;
}

export interface RecurringReport {
  currency: string;
  asOf: string;
  series: RecurringSeries[];
  monthlyOutMinor: number;
  monthlyInMinor: number;
  upcoming: Array<{
    key: string;
    merchant: string;
    direction: Direction;
    date: string;
    amountMinor: number;
    overdue: boolean;
  }>;
  basis: { transactions: number; days: number };
}

export interface UtilizationPoint {
  date: string;
  balanceMinor: number;
  limitMinor: number;
  percent: number;
}

export interface CardUtilization {
  accountId: number;
  name: string;
  color: string | null;
  institutionName: string | null;
  points: UtilizationPoint[];
  latest: UtilizationPoint | null;
}

export interface UtilizationHistory {
  currency: string;
  cards: CardUtilization[];
  total: Array<UtilizationPoint & { cardsIncluded: number }>;
  limitChanges: Array<{
    accountId: number;
    name: string;
    date: string;
    fromMinor: number;
    toMinor: number;
    source: string;
  }>;
}
