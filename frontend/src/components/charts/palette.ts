/** Colors for chart series that have none of their own. Chosen to stay distinct in light and dark. */
export const CHART_COLORS = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#ca8a04",
  "#64748b",
  "#dc2626",
  "#0d9488",
] as const;

export const colorAt = (index: number): string => CHART_COLORS[index % CHART_COLORS.length]!;

/** Spending, income, and "money in / money out" colors used consistently across widgets. */
export const SPENDING_COLOR = "#dc2626";
export const INCOME_COLOR = "#16a34a";
