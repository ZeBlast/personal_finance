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
