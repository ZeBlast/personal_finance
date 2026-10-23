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

/** A small seeded random number generator (mulberry32), so a range is the same on every render. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RangeResult {
  /** The balance at the end of each year (year 0 is today) that 10%, 50% and 90% of runs stay below. */
  low: number[];
  middle: number[];
  high: number[];
  /** Each run's balance at the end, sorted low to high. */
  finals: number[];
}

/**
 * Many possible futures: each year's growth drawn at random from the years on record (the funds'
 * real returns), with the same contributions as `projectBalances`. The spread shows how much the
 * order and size of good and bad years matter. Pure (seeded).
 */
export function simulateRange(input: {
  balanceMinor: number;
  yearlyContributionMinor: number;
  years: number;
  /** Past yearly returns to draw from, such as 0.12 or -0.3. */
  history: number[];
  runs?: number;
  seed?: number;
}): RangeResult {
  const years = Math.max(0, Math.floor(input.years));
  const runs = input.runs ?? 2000;
  const random = seeded(input.seed ?? 1);
  const paths: number[][] = [];
  for (let r = 0; r < runs; r++) {
    const path = [input.balanceMinor];
    let balance = input.balanceMinor;
    for (let y = 1; y <= years; y++) {
      const rate = input.history[Math.floor(random() * input.history.length)] ?? 0;
      balance = balance * (1 + rate) + input.yearlyContributionMinor * (1 + rate / 2);
      path.push(Math.max(0, balance));
    }
    paths.push(path);
  }
  const at = (year: number, q: number) => {
    const sorted = paths.map((p) => p[year]!).sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
  };
  const span = Array.from({ length: years + 1 }, (_, y) => y);
  return {
    low: span.map((y) => at(y, 0.1)),
    middle: span.map((y) => at(y, 0.5)),
    high: span.map((y) => at(y, 0.9)),
    finals: paths.map((p) => Math.round(p[years]!)).sort((a, b) => a - b),
  };
}

/** The share of runs that end at or above a goal, 0 to 1. Pure. */
export function chanceOfReaching(finals: number[], goalMinor: number): number {
  if (finals.length === 0) return 0;
  return finals.filter((f) => f >= goalMinor).length / finals.length;
}

/** The 4% rule of thumb: a yearly amount a balance might support in retirement. */
export const withdrawalPerYear = (balanceMinor: number): number => Math.round(balanceMinor * 0.04);
