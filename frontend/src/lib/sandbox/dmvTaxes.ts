import { bracketTax, type Brackets } from "./brackets";
import type { FilingStatus } from "./taxes";

/**
 * Maryland, Washington DC, and Virginia: state income tax, Maryland's county income taxes, and
 * Virginia's yearly tax on vehicles. Everything can be replaced by the user's own rate or brackets.
 *
 * Sources (tax year 2026):
 * - Maryland state brackets and every county's local rate: Comptroller of Maryland, Central Payroll
 *   Bureau memo "2026 Maryland State and Local Income Tax Withholding Information" (Feb. 4, 2026).
 * - Maryland standard deduction and exemption, DC, and Virginia: Tax Foundation, "2026 State Income
 *   Tax Rates and Brackets" (as of January 1, 2026).
 * - Fairfax County vehicle tax: Fairfax County Department of Tax Administration ($4.57 per $100,
 *   49% state relief on the first $20,000 for 2026, no tax at $1,000 or less).
 * - Prince William County vehicle tax: the county's 2026 tax rates page ($3.50 per $100, 37% relief).
 * - Loudoun County vehicle tax: the Board of Supervisors set $3.09 per $100 for tax year 2026 (news
 *   report); its relief percentage was not confirmed, so it starts at 0% for the user to fill in.
 *
 * 2027 figures had not been published when this was written, so 2027 uses the 2026 figures and says
 * so. Phase-outs (Maryland's exemption above certain incomes), credits, and special cases are left
 * out: these are planning numbers.
 */

export type TaxYear = 2026 | 2027;
export const DMV_TAX_YEARS: TaxYear[] = [2026, 2027];
/** Years whose figures are carried forward because the new ones were not out yet. */
export const CARRIED_FORWARD: Partial<Record<TaxYear, TaxYear>> = { 2027: 2026 };

export type StateCode = "MD" | "DC" | "VA";

interface StateRules {
  name: string;
  single: Brackets;
  married: Brackets;
  standardDeduction: { single: number; married: number };
  /** Personal exemption per person (a deduction from income). */
  exemption: number;
}

const STATE_2026: Record<StateCode, StateRules> = {
  MD: {
    name: "Maryland",
    single: [
      [0, 0.02],
      [1000, 0.03],
      [2000, 0.04],
      [3000, 0.0475],
      [100000, 0.05],
      [125000, 0.0525],
      [150000, 0.055],
      [250000, 0.0575],
      [500000, 0.0625],
      [1000000, 0.065],
    ],
    married: [
      [0, 0.02],
      [1000, 0.03],
      [2000, 0.04],
      [3000, 0.0475],
      [150000, 0.05],
      [175000, 0.0525],
      [225000, 0.055],
      [300000, 0.0575],
      [600000, 0.0625],
      [1200000, 0.065],
    ],
    standardDeduction: { single: 3350, married: 6700 },
    exemption: 3200,
  },
  DC: {
    name: "Washington DC",
    single: [
      [0, 0.04],
      [10000, 0.06],
      [40000, 0.065],
      [60000, 0.085],
      [250000, 0.0925],
      [500000, 0.0975],
      [1000000, 0.1075],
    ],
    married: [
      [0, 0.04],
      [10000, 0.06],
      [40000, 0.065],
      [60000, 0.085],
      [250000, 0.0925],
      [500000, 0.0975],
      [1000000, 0.1075],
    ],
    standardDeduction: { single: 16100, married: 32200 },
    exemption: 0,
  },
  VA: {
    name: "Virginia",
    single: [
      [0, 0.02],
      [3000, 0.03],
      [5000, 0.05],
      [17000, 0.0575],
    ],
    married: [
      [0, 0.02],
      [3000, 0.03],
      [5000, 0.05],
      [17000, 0.0575],
    ],
    standardDeduction: { single: 8750, married: 17500 },
    exemption: 930,
  },
};

export const STATE_CHOICES: Array<{ value: StateCode; label: string }> = [
  { value: "MD", label: "Maryland" },
  { value: "DC", label: "Washington DC" },
  { value: "VA", label: "Virginia" },
];

/** The rules of a year (a year not yet published uses the last one that was). */
const rulesFor = (code: StateCode, _year: TaxYear): StateRules => STATE_2026[code];

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface TaxResult {
  tax: number;
  taxableIncome: number;
  marginalRate: number;
}

/**
 * State income tax for Maryland, DC, or Virginia. `standardDeduction` replaces the official one
 * when given (null or undefined uses it); `brackets` replaces the official brackets.
 */
export function stateTax(
  income: number,
  code: StateCode,
  status: FilingStatus,
  year: TaxYear,
  overrides: { standardDeduction?: number | null; brackets?: Brackets | null } = {},
): TaxResult {
  const rules = rulesFor(code, year);
  const married = status === "married_joint";
  const deduction =
    overrides.standardDeduction ??
    (married ? rules.standardDeduction.married : rules.standardDeduction.single);
  const exemptions = rules.exemption * (married ? 2 : 1);
  const taxable = Math.max(0, Math.max(0, income) - deduction - exemptions);
  const { tax, marginal } = bracketTax(
    taxable,
    overrides.brackets ?? (married ? rules.married : rules.single),
  );
  return {
    tax: round2(tax),
    taxableIncome: round2(taxable),
    marginalRate: taxable > 0 ? marginal : 0,
  };
}

/**
 * A state's official standard deduction and brackets for a filing status and year, as the node
 * shows them (married filing jointly has its own; the others use the single figures).
 */
export function officialStateFigures(
  code: StateCode,
  status: FilingStatus,
  year: TaxYear,
): { standardDeduction: number; brackets: Brackets } {
  const rules = rulesFor(code, year);
  const married = status === "married_joint";
  return {
    standardDeduction: married ? rules.standardDeduction.married : rules.standardDeduction.single,
    brackets: married ? rules.married : rules.single,
  };
}

// ---- Maryland county income tax ----------------------------------------------------------------

export interface MarylandCounty {
  id: string;
  name: string;
  /** A flat rate, or brackets by filing status (Anne Arundel, Frederick). */
  rate?: number;
  single?: Brackets;
  married?: Brackets;
  /** Frederick applies one rate, picked by the income's tier, to all of it. */
  tiered?: boolean;
}

/** 2026 local income tax rates of Maryland's 23 counties and Baltimore City (Comptroller of Maryland). */
export const MARYLAND_COUNTIES: MarylandCounty[] = [
  { id: "allegany", name: "Allegany County", rate: 0.032 },
  {
    id: "anne_arundel",
    name: "Anne Arundel County",
    single: [
      [0, 0.027],
      [50000, 0.0294],
      [400000, 0.032],
    ],
    married: [
      [0, 0.027],
      [75000, 0.0294],
      [480000, 0.032],
    ],
  },
  { id: "baltimore_county", name: "Baltimore County", rate: 0.032 },
  { id: "baltimore_city", name: "Baltimore City", rate: 0.032 },
  { id: "calvert", name: "Calvert County", rate: 0.032 },
  { id: "caroline", name: "Caroline County", rate: 0.032 },
  { id: "carroll", name: "Carroll County", rate: 0.0303 },
  { id: "cecil", name: "Cecil County", rate: 0.0274 },
  { id: "charles", name: "Charles County", rate: 0.0303 },
  { id: "dorchester", name: "Dorchester County", rate: 0.033 },
  {
    id: "frederick",
    name: "Frederick County",
    tiered: true,
    single: [
      [0, 0.0225],
      [25000, 0.0275],
      [50000, 0.0296],
      [150000, 0.032],
    ],
    married: [
      [0, 0.0225],
      [25000, 0.0275],
      [100000, 0.0296],
      [250000, 0.032],
    ],
  },
  { id: "garrett", name: "Garrett County", rate: 0.0265 },
  { id: "harford", name: "Harford County", rate: 0.0306 },
  { id: "howard", name: "Howard County", rate: 0.032 },
  { id: "kent", name: "Kent County", rate: 0.033 },
  { id: "montgomery", name: "Montgomery County", rate: 0.032 },
  { id: "prince_georges", name: "Prince George's County", rate: 0.032 },
  { id: "queen_annes", name: "Queen Anne's County", rate: 0.032 },
  { id: "st_marys", name: "St. Mary's County", rate: 0.032 },
  { id: "somerset", name: "Somerset County", rate: 0.032 },
  { id: "talbot", name: "Talbot County", rate: 0.024 },
  { id: "washington", name: "Washington County", rate: 0.0295 },
  { id: "wicomico", name: "Wicomico County", rate: 0.032 },
  { id: "worcester", name: "Worcester County", rate: 0.0225 },
];

/**
 * Maryland county (or Baltimore City) income tax, on Maryland taxable income. DC and Virginia have
 * no local income taxes.
 */
export function marylandLocalTax(
  income: number,
  countyId: string,
  status: FilingStatus,
  year: TaxYear,
): TaxResult | null {
  const county = MARYLAND_COUNTIES.find((c) => c.id === countyId);
  if (!county) return null;
  const { taxableIncome } = stateTax(income, "MD", status, year);
  const married = status === "married_joint";
  let tax: number;
  let marginal: number;
  if (county.rate !== undefined) {
    tax = taxableIncome * county.rate;
    marginal = county.rate;
  } else {
    const brackets = (married ? county.married : county.single)!;
    if (county.tiered) {
      marginal = 0;
      for (const [floor, rate] of brackets) if (taxableIncome > floor) marginal = rate;
      tax = taxableIncome * marginal;
    } else {
      ({ tax, marginal } = bracketTax(taxableIncome, brackets));
    }
  }
  return { tax: round2(tax), taxableIncome, marginalRate: taxableIncome > 0 ? marginal : 0 };
}

// ---- Virginia vehicle (personal property) tax --------------------------------------------------

export interface VehicleLocality {
  id: string;
  name: string;
  /** Dollars per $100 of assessed value. */
  ratePer100: number;
  /**
   * The state's relief (PPTRA) on the first $20,000 of value, as a percent of the tax; null when
   * it was not confirmed, so the user's own figure (from their bill) is used.
   */
  reliefPercent: number | null;
  /** Vehicles valued at or below this owe nothing (0 for none). */
  exemptUpTo: number;
  source: string;
}

export const VIRGINIA_VEHICLE_LOCALITIES: VehicleLocality[] = [
  {
    id: "fairfax_county",
    name: "Fairfax County",
    ratePer100: 4.57,
    reliefPercent: 49,
    exemptUpTo: 1000,
    source: "Fairfax County Department of Tax Administration, tax year 2026",
  },
  {
    id: "prince_william",
    name: "Prince William County",
    ratePer100: 3.5,
    reliefPercent: 37,
    exemptUpTo: 0,
    source: "Prince William County 2026 tax rates",
  },
  {
    id: "loudoun",
    name: "Loudoun County",
    ratePer100: 3.09,
    reliefPercent: 41,
    exemptUpTo: 0,
    source: "Loudoun County, Property Tax Rates 2026 (vehicle rate $3.09, relief 41%)",
  },
  // Rates below are each locality's personal property rate from the Virginia Department of
  // Taxation's local tax survey (tax year 2025), as reported by tax-rate sites; the relief
  // percentage was not confirmed for 2026, so the node uses the one the user enters from a bill.
  {
    id: "arlington",
    name: "Arlington County (relief not confirmed)",
    ratePer100: 5.0,
    reliefPercent: null,
    exemptUpTo: 0,
    source:
      "Arlington County $5.00 per $100; its relief is tiered, so enter the share from your bill",
  },
  {
    id: "alexandria",
    name: "City of Alexandria (relief not confirmed)",
    ratePer100: 5.33,
    reliefPercent: null,
    exemptUpTo: 0,
    source: "City of Alexandria car tax page, $5.33 per $100",
  },
  {
    id: "fairfax_city",
    name: "City of Fairfax (relief not confirmed)",
    ratePer100: 4.13,
    reliefPercent: null,
    exemptUpTo: 0,
    source: "Virginia Department of Taxation survey, tax year 2025, $4.13 per $100",
  },
  {
    id: "falls_church",
    name: "City of Falls Church (relief not confirmed)",
    ratePer100: 5.0,
    reliefPercent: null,
    exemptUpTo: 0,
    source: "Virginia Department of Taxation survey, tax year 2025, $5.00 per $100",
  },
  {
    id: "manassas",
    name: "City of Manassas (relief not confirmed)",
    ratePer100: 3.6,
    reliefPercent: null,
    exemptUpTo: 0,
    source: "Virginia Department of Taxation survey, tax year 2025, $3.60 per $100",
  },
  {
    id: "manassas_park",
    name: "City of Manassas Park (relief not confirmed)",
    ratePer100: 3.5,
    reliefPercent: null,
    exemptUpTo: 0,
    source: "Virginia Department of Taxation survey, tax year 2025, $3.50 per $100",
  },
];

/** The first $20,000 of a personal vehicle's value gets the state's relief. */
export const PPTRA_RELIEF_CAP = 20_000;

/**
 * Virginia's yearly personal property tax on a personal-use vehicle: the locality's rate on the
 * assessed value, less the state relief on the first $20,000, plus any yearly fees.
 */
export function virginiaVehicleTax(input: {
  value: number;
  ratePer100: number;
  reliefPercent: number;
  exemptUpTo?: number;
  yearlyFees?: number;
}): { tax: number; relief: number; total: number } {
  const value = Math.max(0, input.value);
  const fees = Math.max(0, input.yearlyFees ?? 0);
  if (value <= (input.exemptUpTo ?? 0)) return { tax: 0, relief: 0, total: round2(fees) };
  const rate = Math.max(0, input.ratePer100) / 100;
  const gross = value * rate;
  const relief =
    Math.min(value, PPTRA_RELIEF_CAP) * rate * (Math.max(0, input.reliefPercent) / 100);
  const tax = Math.max(0, gross - relief);
  return { tax: round2(tax), relief: round2(relief), total: round2(tax + fees) };
}
