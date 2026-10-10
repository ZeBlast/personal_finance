import { parseMoneyToMinor } from "./money";

/** Thrift Savings Plan accounts kept by hand (see backend/src/services/tsp.service.ts). */

export const TSP_SUBTYPE = "thrift savings plan";

export interface TspFund {
  symbol: string;
  code: string;
  name: string;
  assetClass: string;
  latest: { date: string; price: number } | null;
}

export interface TspAllocation {
  symbol: string;
  code: string;
  name: string;
  percent: number;
}

/** "once" is a one-time contribution on its start date. */
export type ContributionFrequency = "once" | "weekly" | "biweekly" | "semimonthly" | "monthly";

export interface TspContribution {
  id: number;
  amountMinor: number;
  frequency: ContributionFrequency;
  startDate: string;
  endDate: string | null;
  dayOfMonth: number | null;
  secondDayOfMonth: number | null;
  matchPlan: MatchPlan | null;
  payMinor: number | null;
  matchPercent: number | null;
  matchUpToPercent: number | null;
  autoPercent: number | null;
  /** What the employer adds each time (0 for none). */
  employerMinor: number;
  active: boolean;
  description: string;
  nextDate: string | null;
}

/** `fers`: the federal agency's 1% automatic plus its match; `custom`: your employer's own rule. */
export type MatchPlan = "fers" | "custom";

/**
 * What the employer adds to one contribution, in cents (the same rule the app applies).
 * FERS: 1% of pay always, plus 100% of the first 3% of pay you put in and 50% of the next 2%.
 * Custom: matchPercent% of what you put in, up to matchUpToPercent% of pay, plus autoPercent% of pay.
 */
export function employerAmount(m: {
  amountMinor: number;
  matchPlan: MatchPlan | null;
  payMinor: number | null;
  matchPercent: number | null;
  matchUpToPercent: number | null;
  autoPercent: number | null;
}): number {
  const pay = m.payMinor ?? 0;
  if (!m.matchPlan || pay <= 0) return 0;
  const yours = Math.max(0, m.amountMinor);
  if (m.matchPlan === "fers") {
    const first = Math.min(yours, pay * 0.03);
    const next = Math.min(Math.max(0, yours - pay * 0.03), pay * 0.02);
    return Math.round(pay * 0.01 + first + next * 0.5);
  }
  const matched = Math.min(
    (yours * (m.matchPercent ?? 0)) / 100,
    (pay * (m.matchUpToPercent ?? 0)) / 100,
  );
  return Math.round(matched + (pay * (m.autoPercent ?? 0)) / 100);
}

export interface TspFundPrice {
  symbol: string;
  code: string;
  name: string;
  price: number | null;
  date: string | null;
}

export interface TspSettings {
  accountId: number;
  allocations: TspAllocation[];
  contributions: TspContribution[];
  prices: TspFundPrice[];
  waiting: Array<{ contributionId: number; date: string; missing: string[] }>;
  recent: Array<{
    date: string;
    contributionId: number;
    amountMinor: number;
    /** Of the amount, what the employer put in. */
    employerMinor: number;
    parts: Array<{
      symbol: string;
      code: string;
      units: number;
      price: number;
      priceDate: string;
      amountMinor: number;
    }>;
  }>;
}

// ---- The split between funds ----------------------------------------------------------------

/** One row of the allocation editor: everything is text until saved. */
export interface AllocationRow {
  symbol: string;
  percent: string;
}

/** Reads "60", "12.5", "33.33%" as a percentage above 0 with at most two decimals, or null. */
export function parsePercent(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value > 0 && value <= 100 ? value : null;
}

/** What the rows add up to, counting only the ones that are valid. */
export function allocationTotal(rows: AllocationRow[]): number {
  const sum = rows.reduce(
    (total, r) => total + Math.round((parsePercent(r.percent) ?? 0) * 100),
    0,
  );
  return sum / 100;
}

/** Splits 100% evenly between funds, to the hundredth, the leftover going to the first. */
export function evenSplit(symbols: string[]): AllocationRow[] {
  if (symbols.length === 0) return [];
  const each = Math.floor(10_000 / symbols.length);
  const extra = 10_000 - each * symbols.length;
  return symbols.map((symbol, i) => ({
    symbol,
    percent: String((each + (i === 0 ? extra : 0)) / 100),
  }));
}

export type AllocationResult =
  | { ok: true; allocations: Array<{ symbol: string; percent: number }> }
  | { ok: false; message: string };

/** Checks the editor: funds chosen, none twice, each a valid percentage, together exactly 100%. */
export function buildAllocations(rows: AllocationRow[]): AllocationResult {
  const filled = rows.filter((r) => r.symbol !== "" || r.percent.trim() !== "");
  if (filled.length === 0) return { ok: false, message: "Choose at least one fund." };
  const seen = new Set<string>();
  const allocations: Array<{ symbol: string; percent: number }> = [];
  for (const row of filled) {
    if (row.symbol === "") return { ok: false, message: "Choose a fund for each row." };
    if (seen.has(row.symbol)) return { ok: false, message: "Each fund can be listed only once." };
    seen.add(row.symbol);
    const percent = parsePercent(row.percent);
    if (percent === null) {
      return {
        ok: false,
        message: "Enter each percentage above 0 and up to 100, with at most two decimals.",
      };
    }
    allocations.push({ symbol: row.symbol, percent });
  }
  const total = allocationTotal(filled);
  if (total !== 100) {
    return { ok: false, message: `The percentages add up to ${total}%. They must add up to 100%.` };
  }
  return { ok: true, allocations };
}

export function rowsFromAllocations(allocations: TspAllocation[]): AllocationRow[] {
  return allocations.map((a) => ({ symbol: a.symbol, percent: String(a.percent) }));
}

/** About how many units a contribution buys of a fund at a price: 300.00 at 110.00 is 2.7273. */
export function estimateUnits(
  amountMinor: number,
  percent: number,
  price: number | null,
): number | null {
  if (price === null || price <= 0) return null;
  return Math.round(((amountMinor / 100) * (percent / 100) * 10_000) / price) / 10_000;
}

// ---- Contributions (recurring or one-time) --------------------------------------------------

export const FREQUENCY_OPTIONS: Array<{ value: ContributionFrequency; label: string }> = [
  { value: "once", label: "One time" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks (biweekly)" },
  { value: "semimonthly", label: "Twice a month" },
  { value: "monthly", label: "Every month" },
];

export interface ContributionDraft {
  amount: string;
  frequency: ContributionFrequency;
  startDate: string;
  endDate: string;
  /** Monthly and twice-a-month: the day of the month ("" for the start date's day, or "-1" for the last). */
  dayOfMonth: string;
  /** Twice a month: the second day ("" for 14 days after the first, up to the 28th). */
  secondDay: string;
  /** "" for no employer money. */
  matchPlan: "" | MatchPlan;
  /** Gross pay for each contribution period, in dollars. */
  pay: string;
  matchPercent: string;
  matchUpTo: string;
  autoPercent: string;
}

export function emptyContributionDraft(
  startDate: string,
  frequency: ContributionFrequency = "biweekly",
): ContributionDraft {
  return {
    amount: "",
    frequency,
    startDate,
    endDate: "",
    dayOfMonth: "",
    secondDay: "",
    matchPlan: "",
    pay: "",
    matchPercent: "",
    matchUpTo: "",
    autoPercent: "",
  };
}

export function draftFromContribution(c: TspContribution): ContributionDraft {
  return {
    amount: (c.amountMinor / 100).toFixed(2),
    frequency: c.frequency,
    startDate: c.startDate,
    endDate: c.endDate ?? "",
    dayOfMonth: c.dayOfMonth === null ? "" : String(c.dayOfMonth),
    secondDay: c.secondDayOfMonth === null ? "" : String(c.secondDayOfMonth),
    matchPlan: c.matchPlan ?? "",
    pay: c.payMinor === null ? "" : (c.payMinor / 100).toFixed(2),
    matchPercent: c.matchPercent === null ? "" : String(c.matchPercent),
    matchUpTo: c.matchUpToPercent === null ? "" : String(c.matchUpToPercent),
    autoPercent: c.autoPercent === null ? "" : String(c.autoPercent),
  };
}

/** The employer-match part of a contribution's payload, or a message saying what is wrong. */
export function buildMatch(
  draft: ContributionDraft,
): { ok: true; fields: Record<string, unknown> } | { ok: false; message: string } {
  if (draft.matchPlan === "") return { ok: true, fields: { matchPlan: null } };
  const payMinor = parseMoneyToMinor(draft.pay, "USD");
  if (payMinor === null || payMinor <= 0) {
    return { ok: false, message: "Enter your gross pay for each contribution, such as 4000.00." };
  }
  if (draft.matchPlan === "fers") return { ok: true, fields: { matchPlan: "fers", payMinor } };
  const pct = (text: string): number | null => {
    if (text.trim() === "") return 0;
    const n = Number(text.replace("%", "").trim());
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  };
  const matchPercent = draft.matchPercent.trim() === "" ? 100 : pct(draft.matchPercent);
  const matchUpToPercent = pct(draft.matchUpTo);
  const autoPercent = pct(draft.autoPercent);
  if (matchPercent === null || matchUpToPercent === null || autoPercent === null) {
    return { ok: false, message: "Match percentages are numbers from 0 to 100." };
  }
  return {
    ok: true,
    fields: { matchPlan: "custom", payMinor, matchPercent, matchUpToPercent, autoPercent },
  };
}

export type ContributionResult =
  { ok: true; payload: Record<string, unknown> } | { ok: false; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildContribution(draft: ContributionDraft): ContributionResult {
  const amountMinor = parseMoneyToMinor(draft.amount, "USD");
  if (amountMinor === null) {
    return { ok: false, message: "Enter the amount of each contribution, such as 500.00." };
  }
  const once = draft.frequency === "once";
  if (!DATE.test(draft.startDate)) {
    return { ok: false, message: once ? "Choose the date." : "Choose the first date." };
  }
  const match = buildMatch(draft);
  if (!match.ok) return match;
  if (once) {
    return {
      ok: true,
      payload: {
        amountMinor,
        frequency: "once",
        startDate: draft.startDate,
        endDate: null,
        ...match.fields,
      },
    };
  }
  if (draft.endDate !== "" && !DATE.test(draft.endDate)) {
    return { ok: false, message: "Choose a valid end date, or leave it empty." };
  }
  if (draft.endDate !== "" && draft.endDate < draft.startDate) {
    return { ok: false, message: "The end date is before the start date." };
  }
  const monthly = draft.frequency === "monthly" || draft.frequency === "semimonthly";
  const day = (text: string): number | null => (text.trim() === "" ? null : Number(text));
  for (const text of monthly ? [draft.dayOfMonth, draft.secondDay] : []) {
    const n = day(text);
    if (n !== null && n !== -1 && (!Number.isInteger(n) || n < 1 || n > 31)) {
      return { ok: false, message: "A day of the month is 1 to 31, or the last day." };
    }
  }
  return {
    ok: true,
    payload: {
      amountMinor,
      frequency: draft.frequency,
      startDate: draft.startDate,
      endDate: draft.endDate === "" ? null : draft.endDate,
      ...(monthly ? { dayOfMonth: day(draft.dayOfMonth) } : {}),
      ...(draft.frequency === "semimonthly" ? { secondDayOfMonth: day(draft.secondDay) } : {}),
      ...match.fields,
    },
  };
}

/** Units shown to four decimals, without needless trailing zeros. */
export function formatUnits(units: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(units);
}

// ---- Downloading prices ---------------------------------------------------------------------

export type PriceSource = "maxtsp" | "tsp.gov";

export const SOURCE_OPTIONS: Array<{ value: PriceSource; label: string }> = [
  { value: "maxtsp", label: "Max TSP API (api.maxtsp.com)" },
  { value: "tsp.gov", label: "tsp.gov (often refuses downloads)" },
];

export type HistoryRange = "30" | "90" | "365" | "1825" | "all" | "since";

export const HISTORY_OPTIONS: Array<{ value: HistoryRange; label: string }> = [
  { value: "30", label: "The last month" },
  { value: "90", label: "The last 3 months" },
  { value: "365", label: "The last year" },
  { value: "1825", label: "The last 5 years" },
  { value: "since", label: "Since the day I got the funds…" },
  { value: "all", label: "Everything available" },
];

export type FetchRequestResult =
  | { ok: true; body: { source: PriceSource; days?: number; since?: string } }
  | { ok: false; message: string };

/** The request for "download prices from this source, going back this far". */
export function buildFetchRequest(
  source: PriceSource,
  range: HistoryRange,
  since: string,
  today: string,
): FetchRequestResult {
  if (range === "since") {
    if (!DATE.test(since))
      return { ok: false, message: "Choose the day you started holding the funds." };
    if (since > today) return { ok: false, message: "That day is in the future." };
    return { ok: true, body: { source, since } };
  }
  if (range === "all") return { ok: true, body: { source, since: "2003-01-01" } };
  return { ok: true, body: { source, days: Number(range) } };
}
