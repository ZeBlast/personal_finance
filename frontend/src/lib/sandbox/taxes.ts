/**
 * US federal income tax and payroll tax (FICA), for the sandbox. Amounts are yearly dollars.
 *
 * The figures are the IRS's published ones for each year as known when this was written (2026
 * figures from IRS Rev. Proc. 2025-32 and the Social Security Administration's 2026 wage base;
 * 2025 figures as revised by the 2025 tax law). They are for planning, not for filing: credits,
 * itemized deductions, and many special cases are left out.
 */

export type FilingStatus = "single" | "married_joint" | "head_of_household";
export type TaxYear = 2025 | 2026;

export const FILING_STATUSES: Array<{ value: FilingStatus; label: string }> = [
  { value: "single", label: "Single" },
  { value: "married_joint", label: "Married filing jointly" },
  { value: "head_of_household", label: "Head of household" },
];
export const TAX_YEARS: TaxYear[] = [2026, 2025];

const RATES = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];

/** The top of each bracket but the last, by year and filing status. */
const BRACKETS: Record<TaxYear, Record<FilingStatus, number[]>> = {
  2025: {
    single: [11_925, 48_475, 103_350, 197_300, 250_525, 626_350],
    married_joint: [23_850, 96_950, 206_700, 394_600, 501_050, 751_600],
    head_of_household: [17_000, 64_850, 103_350, 197_300, 250_500, 626_350],
  },
  2026: {
    single: [12_400, 50_400, 105_700, 201_775, 256_225, 640_600],
    married_joint: [24_800, 100_800, 211_400, 403_550, 512_450, 768_700],
    head_of_household: [17_700, 67_450, 105_700, 201_750, 256_200, 640_600],
  },
};

export const STANDARD_DEDUCTION: Record<TaxYear, Record<FilingStatus, number>> = {
  2025: { single: 15_750, married_joint: 31_500, head_of_household: 23_625 },
  2026: { single: 16_100, married_joint: 32_200, head_of_household: 24_150 },
};

/** Social Security tax applies to wages up to this much a year. */
export const SOCIAL_SECURITY_WAGE_BASE: Record<TaxYear, number> = { 2025: 176_100, 2026: 184_500 };
const SOCIAL_SECURITY_RATE = 0.062;
const MEDICARE_RATE = 0.0145;
const ADDITIONAL_MEDICARE_RATE = 0.009;
const ADDITIONAL_MEDICARE_FROM: Record<FilingStatus, number> = {
  single: 200_000,
  married_joint: 250_000,
  head_of_household: 200_000,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface FederalTax {
  /** Income after the deduction, which the brackets apply to. */
  taxableIncome: number;
  tax: number;
  /** Tax as a share of gross income (0-1). */
  effectiveRate: number;
  /** The rate on the next dollar (0-1). */
  marginalRate: number;
  deduction: number;
}

/**
 * Federal income tax on a year's income. `deduction` defaults to the standard deduction; pass
 * an itemized total instead to use that.
 */
export function federalIncomeTax(
  grossIncome: number,
  status: FilingStatus,
  year: TaxYear,
  deduction: number = STANDARD_DEDUCTION[year][status],
): FederalTax {
  const income = Math.max(0, grossIncome);
  const taxable = Math.max(0, income - Math.max(0, deduction));
  const tops = BRACKETS[year][status];
  let tax = 0;
  let floor = 0;
  let marginal = RATES[0]!;
  for (let i = 0; i < RATES.length; i++) {
    const top = tops[i] ?? Infinity;
    if (taxable > floor) {
      tax += (Math.min(taxable, top) - floor) * RATES[i]!;
      marginal = RATES[i]!;
    }
    floor = top;
  }
  if (taxable === 0) marginal = 0;
  return {
    taxableIncome: round2(taxable),
    tax: round2(tax),
    effectiveRate: income > 0 ? tax / income : 0,
    marginalRate: marginal,
    deduction: round2(Math.max(0, deduction)),
  };
}

export interface PayrollTax {
  socialSecurity: number;
  /** All Medicare: the 1.45% plus any additional 0.9%. */
  medicare: number;
  /** The additional 0.9% Medicare on wages above the threshold (part of `medicare`). */
  additionalMedicare: number;
  total: number;
}

/** Social Security and Medicare (FICA) withheld from a year's wages (the employee's share). */
export function payrollTax(wages: number, status: FilingStatus, year: TaxYear): PayrollTax {
  const w = Math.max(0, wages);
  const socialSecurity = Math.min(w, SOCIAL_SECURITY_WAGE_BASE[year]) * SOCIAL_SECURITY_RATE;
  const additional = Math.max(0, w - ADDITIONAL_MEDICARE_FROM[status]) * ADDITIONAL_MEDICARE_RATE;
  const medicare = w * MEDICARE_RATE + additional;
  return {
    socialSecurity: round2(socialSecurity),
    medicare: round2(medicare),
    additionalMedicare: round2(additional),
    total: round2(socialSecurity + medicare),
  };
}

/**
 * FERS: the retirement contribution withheld from a federal employee's basic pay. The rate depends
 * on when the employee was first hired (and is higher for law enforcement officers, firefighters
 * and air traffic controllers). The contribution is not pre-tax: it still counts as taxable income.
 */
export const FERS_PLANS: Array<{ value: string; label: string; rate: number }> = [
  { value: "fers", label: "FERS (hired before 2013): 0.8%", rate: 0.008 },
  { value: "fers_rae", label: "FERS-RAE (hired in 2013): 3.1%", rate: 0.031 },
  { value: "fers_frae", label: "FERS-FRAE (hired 2014 or later): 4.4%", rate: 0.044 },
  { value: "fers_special", label: "FERS, special category (before 2013): 1.3%", rate: 0.013 },
  { value: "fers_rae_special", label: "FERS-RAE, special category: 3.6%", rate: 0.036 },
  { value: "fers_frae_special", label: "FERS-FRAE, special category: 4.9%", rate: 0.049 },
];

/** The FERS contribution on a year's basic pay at `rate` (0-1). */
export function fersContribution(basicPay: number, rate: number): number {
  return round2(Math.max(0, basicPay) * Math.max(0, rate));
}
