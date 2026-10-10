import {
  marylandLocalTax,
  stateTax,
  STATE_CHOICES,
  MARYLAND_COUNTIES,
  type TaxYear as LocalYear,
} from "../sandbox/dmvTaxes";
import {
  federalIncomeTax,
  payrollTax,
  type FilingStatus,
  type TaxYear as FederalYear,
} from "../sandbox/taxes";

/** One income source, as the user describes it (dollars). */
export interface SourceInput {
  key: string;
  label: string;
  kind: "income" | "credit" | "manual";
  /** What it pays in the year; null uses `suggested`. */
  annualIncome: number | null;
  /** What the transactions point to for the whole year. */
  suggested: number;
  ficaExempt: boolean;
  pretaxRetirement: number;
  pretaxBenefits: number;
  excluded: boolean;
}

export interface TaxInputs {
  year: number;
  filingStatus: FilingStatus;
  state: "MD" | "DC" | "VA" | "none";
  marylandCounty: string | null;
  customLocalRate: number | null;
  customLocalName: string | null;
  federalWithheld: number | null;
  stateWithheld: number | null;
  sources: SourceInput[];
}

export interface TaxLine {
  label: string;
  amount: number;
  note?: string;
}

export interface TaxEstimate {
  grossIncome: number;
  pretax: number;
  /** Income the federal and state income taxes start from (after pre-tax contributions). */
  taxableWages: number;
  ficaWages: number;
  federal: { tax: number; deduction: number; taxableIncome: number; marginalRate: number };
  socialSecurity: number;
  medicare: number;
  /** State and local income taxes, one line each. */
  stateLines: TaxLine[];
  stateTotal: number;
  total: number;
  effectiveRate: number;
  takeHome: number;
  /** Tax years whose official figures are not out yet, so an earlier year's are used. */
  federalYearUsed: FederalYear;
  localYearUsed: LocalYear;
  /** Still owed (positive) or coming back (negative), when withholding was entered. */
  federalBalance: number | null;
  stateBalance: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pos = (n: number): number => Math.max(0, Number.isFinite(n) ? n : 0);

export const federalYearFor = (year: number): FederalYear => (year >= 2026 ? 2026 : 2025);
export const localYearFor = (year: number): LocalYear => (year >= 2027 ? 2027 : 2026);

/** The amount a source counts for: what the user entered, or else the suggestion. */
export const annualOf = (s: SourceInput): number => pos(s.annualIncome ?? s.suggested);

/**
 * A whole year's income from what has come in so far: the total itself for a year that is over,
 * or scaled up by the share of the year gone by for the current one.
 */
export function projectAnnual(totalSoFar: number, year: number, today: Date): number {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) + 86_400_000;
  if (now >= end || now <= start) return round2(totalSoFar);
  return round2((totalSoFar * (end - start)) / (now - start));
}

/**
 * What a source will likely pay in the whole year, from what it has paid so far. Only income that
 * repeats (two or more payments) is scaled up, from its first payment to the end of the year, so
 * a job that started mid-year is not underestimated. Credits and one-off money count as they are.
 */
export function suggestAnnual(
  s: { totalMinor: number; count: number; kind: "income" | "credit"; firstDate: string },
  year: number,
  today: Date,
): number {
  const total = s.totalMinor / 100;
  if (s.kind !== "income" || s.count < 2) return round2(total);
  const day = (d: string): number => Date.parse(`${d}T00:00:00Z`);
  const start = Math.max(day(s.firstDate), Date.UTC(year, 0, 1));
  const end = Date.UTC(year + 1, 0, 1);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) + 86_400_000;
  if (now >= end || now <= start) return round2(total);
  return round2((total * (end - start)) / (now - start));
}

export function estimateTaxes(input: TaxInputs): TaxEstimate {
  const fy = federalYearFor(input.year);
  const ly = localYearFor(input.year);
  const status = input.filingStatus;
  let gross = 0;
  let pretax = 0;
  let ficaWages = 0;
  for (const s of input.sources) {
    if (s.excluded) continue;
    const amount = annualOf(s);
    const retirement = Math.min(pos(s.pretaxRetirement), amount);
    const benefits = Math.min(pos(s.pretaxBenefits), amount - retirement);
    gross += amount;
    pretax += retirement + benefits;
    // 401(k)/TSP money still pays FICA; payroll health and FSA money does not.
    if (!s.ficaExempt) ficaWages += amount - benefits;
  }
  const taxable = pos(gross - pretax);
  const federal = federalIncomeTax(taxable, status, fy);
  const payroll = payrollTax(ficaWages, status, fy);

  const stateLines: TaxLine[] = [];
  if (input.state !== "none") {
    const name = STATE_CHOICES.find((c) => c.value === input.state)?.label ?? input.state;
    stateLines.push({
      label: `${name} income tax`,
      amount: stateTax(taxable, input.state, status, ly).tax,
    });
    if (input.state === "MD" && input.marylandCounty) {
      const county = MARYLAND_COUNTIES.find((c) => c.id === input.marylandCounty);
      const local = marylandLocalTax(taxable, input.marylandCounty, status, ly);
      if (county && local)
        stateLines.push({ label: `${county.name} income tax`, amount: local.tax });
    }
  }
  if (input.customLocalRate) {
    stateLines.push({
      label: input.customLocalName?.trim() || "Other local income tax",
      amount: round2((taxable * input.customLocalRate) / 100),
      note: `${input.customLocalRate}% of taxable income`,
    });
  }
  const stateTotal = round2(stateLines.reduce((sum, l) => sum + l.amount, 0));
  const total = round2(federal.tax + payroll.total + stateTotal);
  const withheld = (v: number | null, owed: number): number | null =>
    v === null ? null : round2(owed - v);
  return {
    grossIncome: round2(gross),
    pretax: round2(pretax),
    taxableWages: round2(taxable),
    ficaWages: round2(ficaWages),
    federal: {
      tax: federal.tax,
      deduction: federal.deduction,
      taxableIncome: federal.taxableIncome,
      marginalRate: federal.marginalRate,
    },
    socialSecurity: payroll.socialSecurity,
    medicare: payroll.medicare,
    stateLines,
    stateTotal,
    total,
    effectiveRate: gross > 0 ? total / gross : 0,
    takeHome: round2(gross - pretax - total),
    federalYearUsed: fy,
    localYearUsed: ly,
    federalBalance: withheld(input.federalWithheld, federal.tax),
    stateBalance: withheld(input.stateWithheld, stateTotal),
  };
}
