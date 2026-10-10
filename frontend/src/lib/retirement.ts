/**
 * A simple retirement projection: today's balance growing at a steady yearly rate, with the same
 * contributions added every year (spread through the year, so each year's money grows for half a
 * year on average). It is an illustration, not a forecast: real returns vary year to year.
 */

export interface ProjectionInput {
  /** Today's balance, in cents. */
  balanceMinor: number;
  /** What goes in each year (yours and your employer's), in cents. */
  yearlyContributionMinor: number;
  years: number;
  /** Yearly growth, such as 0.06. */
  rate: number;
}

/** The balance at the end of each year, starting with today (year 0). */
export function projectBalances(input: ProjectionInput): number[] {
  const out = [Math.round(input.balanceMinor)];
  let balance = input.balanceMinor;
  for (let y = 1; y <= Math.max(0, Math.floor(input.years)); y++) {
    balance = balance * (1 + input.rate) + input.yearlyContributionMinor * (1 + input.rate / 2);
    out.push(Math.round(balance));
  }
  return out;
}

/** An amount `years` from now in today's dollars, at a steady inflation rate. */
export function inTodaysDollars(minor: number, years: number, inflation: number): number {
  return Math.round(minor / Math.pow(1 + inflation, years));
}

/** How many contributions a schedule makes in a year (a one-time one makes none going forward). */
export const PER_YEAR: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  once: 0,
};

/** A year of recurring contributions (yours plus the employer's), from the TSP settings. */
export function yearlyContributions(
  contributions: Array<{
    amountMinor: number;
    employerMinor: number;
    frequency: string;
    active: boolean;
    endDate: string | null;
  }>,
  today: string,
): number {
  return contributions
    .filter((c) => c.active && (c.endDate === null || c.endDate >= today))
    .reduce((n, c) => n + (c.amountMinor + c.employerMinor) * (PER_YEAR[c.frequency] ?? 0), 0);
}

/** The 4% rule of thumb: a yearly amount a balance might support in retirement. */
export const withdrawalPerYear = (balanceMinor: number): number => Math.round(balanceMinor * 0.04);
