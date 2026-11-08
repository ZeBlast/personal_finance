/** Shapes returned by backend/src/routes/plan-tools.routes.ts. */

export interface SafetyNet {
  currency: string;
  cashMinor: number;
  reservedMinor: number;
  freeCashMinor: number;
  monthlyMinor: number;
  basis: "essential" | "all";
  monthsAveraged: number;
  months: number | null;
  essentials: Array<{ id: number; name: string; monthlyMinor: number }>;
}

type Day = { date: string; balanceMinor: number };

export interface AffordAnswer {
  currency: string;
  today: string;
  amountMinor: number;
  bufferMinor: number;
  reservedMinor: number;
  floorMinor: number;
  horizonEnd: string;
  alreadyShort: boolean;
  asked: { date: string; ok: boolean; lowest: Day; marginMinor: number } | null;
  earliest: { date: string; lowest: Day } | null;
  plans: Array<{ months: 3 | 6 | 12; perMonthMinor: number; by: string }>;
}

export type YearItemKind =
  | "yearly"
  | "quarterly"
  | "planned"
  | "extra_paycheck"
  | "goal_date"
  | "debt_paid_off"
  | "fund_target";

export interface YearItem {
  date: string;
  label: string;
  amountMinor: number;
  kind: YearItemKind;
}

export interface YearMonth {
  month: string;
  incomeMinor: number;
  billsMinor: number;
  capsMinor: number;
  netMinor: number;
  short: boolean;
  items: YearItem[];
}

export interface YearAhead {
  currency: string;
  today: string;
  months: YearMonth[];
}

export type PlanKind = "income" | "bill" | "cap" | "usual" | "goal" | "debt";

export interface PlanLine {
  kind: PlanKind;
  label: string;
  amountMinor: number;
  note?: string;
}

export interface MonthPlan {
  currency: string;
  month: string;
  today: string;
  lines: PlanLine[];
  totals: Record<PlanKind, number>;
  leftMinor: number;
  actual: { incomeMinor: number; spendingMinor: number; through: string } | null;
}
