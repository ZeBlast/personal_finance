import { daysBetween } from "../components/charts/math";
import type { Cadence } from "../types/insights";

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
  quarterly: "Every 3 months",
  yearly: "Every year",
};

export type UtilizationTone = "good" | "fair" | "high" | "veryHigh";

/**
 * Plain bands for how much of a limit is used. Under 30% is the figure most often given as healthy;
 * these are rules of thumb, not a prediction of any credit score.
 */
export function utilizationTone(percent: number): {
  tone: UtilizationTone;
  label: string;
  color: string;
} {
  if (percent < 30) return { tone: "good", label: "Low", color: "#16a34a" };
  if (percent < 50) return { tone: "fair", label: "Moderate", color: "#ca8a04" };
  if (percent < 75) return { tone: "high", label: "High", color: "#ea580c" };
  return { tone: "veryHigh", label: "Very high", color: "#dc2626" };
}

/** "today", "tomorrow", "in 5 days", "yesterday", "3 days ago". */
export function dueLabel(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** A percent for display: "20.5%", whole numbers without a decimal ("30%"). */
export function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}
