import { bracketTax, formatBrackets, parseBrackets } from "./brackets";
import {
  DMV_TAX_YEARS,
  MARYLAND_COUNTIES,
  marylandLocalTax,
  officialStateFigures,
  STATE_CHOICES,
  stateTax,
  VIRGINIA_VEHICLE_LOCALITIES,
  virginiaVehicleTax,
  type StateCode,
  type TaxYear as DmvTaxYear,
} from "./dmvTaxes";
import {
  federalIncomeTax,
  FERS_PLANS,
  fersContribution,
  FILING_STATUSES,
  payrollTax,
  TAX_YEARS,
  type FilingStatus,
  type TaxYear,
} from "./taxes";

/**
 * The sandbox: a graph of nodes joined by wires. Each node takes numbers in on its input ports and
 * gives numbers out on its output ports; a wire carries a number from an output to an input. All
 * money is yearly dollars, so an hourly wage and a monthly bill can be added together. Several
 * wires into one input are added up.
 */

export type ParamValue = string | number | boolean;

export interface SandboxNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  /** A name the user gave it (shown instead of the kind's). */
  title?: string;
  params: Record<string, ParamValue>;
}

export interface Wire {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface Graph {
  nodes: SandboxNode[];
  wires: Wire[];
}

export type ValueFormat = "money" | "percent" | "number";

export interface PortDef {
  id: string;
  label: string;
  format?: ValueFormat;
}

export interface ParamDef {
  key: string;
  label: string;
  type: "money" | "number" | "percent" | "select" | "text";
  options?: Array<{ value: string; label: string }>;
  default: ParamValue;
}

/** Numbers from the user's own data, worked out by the page, yearly. */
export type DataValues = Record<string, number>;

interface Ctx {
  data: DataValues;
}

interface NodeDef {
  label: string;
  group: "Money" | "Math" | "Taxes" | "Results";
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  compute: (
    inputs: Record<string, number[]>,
    params: Record<string, ParamValue>,
    ctx: Ctx,
  ) => Record<string, number>;
  /**
   * After a setting changes (`after`, from `before`), other settings it fills in: such as a
   * state's official deduction and brackets once the state is chosen.
   */
  autofill?: (
    before: Record<string, ParamValue>,
    after: Record<string, ParamValue>,
  ) => Record<string, ParamValue>;
}

/** The official deduction and brackets the state tax node shows for its settings, or null. */
function stateFigureText(
  p: Record<string, ParamValue>,
): { deduction: string; brackets: string } | null {
  const state = String(p["state"] ?? "");
  if (!isStateCode(state)) return null;
  const f = officialStateFigures(
    state,
    String(p["status"] ?? "single") as FilingStatus,
    dmvYear(p),
  );
  return { deduction: String(f.standardDeduction), brackets: formatBrackets(f.brackets) };
}

/**
 * A node's settings after one changed, with what that fills in (see NodeDef.autofill). Pure, so
 * it can be tested; the page applies it as the user edits.
 */
export function withAutofill(
  kind: NodeKind,
  before: Record<string, ParamValue>,
  after: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const fill = nodeDef(kind).autofill?.(before, after) ?? {};
  return { ...after, ...fill };
}

export const PERIODS: Array<{ value: string; label: string; perYear: number }> = [
  { value: "hourly", label: "per hour", perYear: 0 }, // uses hours per week
  { value: "weekly", label: "per week", perYear: 52 },
  { value: "biweekly", label: "every 2 weeks", perYear: 26 },
  { value: "semimonthly", label: "twice a month", perYear: 24 },
  { value: "monthly", label: "per month", perYear: 12 },
  { value: "yearly", label: "per year", perYear: 1 },
];

const periodParam: ParamDef = {
  key: "period",
  label: "How often",
  type: "select",
  options: PERIODS.map((p) => ({ value: p.value, label: p.label })),
  default: "yearly",
};

export function toYearly(amount: number, period: string, hoursPerWeek = 40): number {
  if (period === "hourly") return amount * hoursPerWeek * 52;
  return amount * (PERIODS.find((p) => p.value === period)?.perYear ?? 1);
}

const num = (v: ParamValue | undefined): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const sum = (values: number[] | undefined): number => (values ?? []).reduce((a, b) => a + b, 0);
const has = (values: number[] | undefined): boolean => (values ?? []).length > 0;

const statusParam: ParamDef = {
  key: "status",
  label: "Filing status",
  type: "select",
  options: FILING_STATUSES.map((s) => ({ value: s.value, label: s.label })),
  default: "single",
};
const yearParam: ParamDef = {
  key: "year",
  label: "Tax year",
  type: "select",
  options: [
    { value: "2027", label: "2027 (uses 2026 figures until published)" },
    ...TAX_YEARS.map((y) => ({ value: String(y), label: String(y) })),
  ],
  default: "2026",
};
/** The federal figures to use: 2027 is not published yet, so it uses 2026's. */
const federalYear = (p: Record<string, ParamValue>): TaxYear =>
  (Number(p["year"]) >= 2026 ? 2026 : 2025) as TaxYear;

const dmvYearParam: ParamDef = {
  key: "taxYear",
  label: "Tax year",
  type: "select",
  options: DMV_TAX_YEARS.map((y) => ({
    value: String(y),
    label: y === 2027 ? "2027 (uses 2026 figures until published)" : String(y),
  })),
  default: "2026",
};
const dmvYear = (p: Record<string, ParamValue>): DmvTaxYear =>
  (Number(p["taxYear"] ?? 2026) === 2027 ? 2027 : 2026) as DmvTaxYear;
const isStateCode = (v: string): v is StateCode => v === "MD" || v === "DC" || v === "VA";

export const NODE_DEFS = {
  income: {
    label: "Income",
    group: "Money",
    description: "Pay or other income, turned into a yearly amount.",
    inputs: [],
    outputs: [{ id: "yearly", label: "Per year", format: "money" }],
    params: [
      { key: "amount", label: "Amount", type: "money", default: 60_000 },
      periodParam,
      { key: "hours", label: "Hours per week (hourly)", type: "number", default: 40 },
    ],
    compute: (_i, p) => ({
      yearly: toYearly(num(p["amount"]), String(p["period"]), num(p["hours"]) || 40),
    }),
  },
  expense: {
    label: "Expense",
    group: "Money",
    description: "A cost, such as rent or a subscription, as a yearly amount.",
    inputs: [],
    outputs: [{ id: "yearly", label: "Per year", format: "money" }],
    params: [
      { key: "amount", label: "Amount", type: "money", default: 1_500 },
      { ...periodParam, default: "monthly" },
    ],
    compute: (_i, p) => ({ yearly: toYearly(num(p["amount"]), String(p["period"])) }),
  },
  data: {
    label: "From my data",
    group: "Money",
    description: "Your real income or spending, averaged over recent months, per year.",
    inputs: [],
    outputs: [{ id: "yearly", label: "Per year", format: "money" }],
    params: [
      {
        key: "source",
        label: "What",
        type: "select",
        options: [
          { value: "income", label: "Income" },
          { value: "spending", label: "Spending" },
        ],
        default: "spending",
      },
      {
        key: "months",
        label: "Average of the last",
        type: "select",
        options: [
          { value: "3", label: "3 months" },
          { value: "6", label: "6 months" },
          { value: "12", label: "12 months" },
        ],
        default: "6",
      },
    ],
    compute: (_i, p, ctx) => ({
      yearly: ctx.data[`${String(p["source"])}:${String(p["months"])}`] ?? 0,
    }),
  },
  number: {
    label: "Number",
    group: "Math",
    description: "A fixed number.",
    inputs: [],
    outputs: [{ id: "value", label: "Value", format: "number" }],
    params: [{ key: "value", label: "Value", type: "number", default: 1 }],
    compute: (_i, p) => ({ value: num(p["value"]) }),
  },
  add: {
    label: "Add",
    group: "Math",
    description: "Adds up everything wired in.",
    inputs: [{ id: "values", label: "Values" }],
    outputs: [{ id: "sum", label: "Sum", format: "money" }],
    params: [],
    compute: (i) => ({ sum: sum(i["values"]) }),
  },
  subtract: {
    label: "Subtract",
    group: "Math",
    description: "Takes everything on “minus” away from “from”.",
    inputs: [
      { id: "from", label: "From" },
      { id: "minus", label: "Minus" },
    ],
    outputs: [{ id: "result", label: "Result", format: "money" }],
    params: [],
    compute: (i) => ({ result: sum(i["from"]) - sum(i["minus"]) }),
  },
  multiply: {
    label: "Multiply",
    group: "Math",
    description: "Multiplies everything wired in.",
    inputs: [{ id: "values", label: "Values" }],
    outputs: [{ id: "product", label: "Product", format: "money" }],
    params: [],
    compute: (i) => ({
      product: has(i["values"]) ? i["values"]!.reduce((a, b) => a * b, 1) : 0,
    }),
  },
  divide: {
    label: "Divide",
    group: "Math",
    description: "Divides one number by another.",
    inputs: [
      { id: "a", label: "Number" },
      { id: "b", label: "Divided by" },
    ],
    outputs: [{ id: "result", label: "Result", format: "money" }],
    params: [],
    compute: (i) => {
      const b = sum(i["b"]);
      if (b === 0) throw new Error("Cannot divide by zero.");
      return { result: sum(i["a"]) / b };
    },
  },
  percent: {
    label: "Percent of",
    group: "Math",
    description: "A percentage of what is wired in, and what is left.",
    inputs: [{ id: "value", label: "Of" }],
    outputs: [
      { id: "part", label: "Part", format: "money" },
      { id: "rest", label: "Rest", format: "money" },
    ],
    params: [{ key: "rate", label: "Percent", type: "percent", default: 10 }],
    compute: (i, p) => {
      const value = sum(i["value"]);
      const part = (value * num(p["rate"])) / 100;
      return { part, rest: value - part };
    },
  },
  per_period: {
    label: "Per period",
    group: "Math",
    description: "A yearly amount as per month, per paycheck, per week.",
    inputs: [{ id: "yearly", label: "Per year" }],
    outputs: [
      { id: "monthly", label: "Per month", format: "money" },
      { id: "biweekly", label: "Every 2 weeks", format: "money" },
      { id: "weekly", label: "Per week", format: "money" },
    ],
    params: [],
    compute: (i) => {
      const y = sum(i["yearly"]);
      return { monthly: y / 12, biweekly: y / 26, weekly: y / 52 };
    },
  },
  federal_tax: {
    label: "Federal income tax",
    group: "Taxes",
    description:
      "US federal income tax by the brackets, after pre-tax deductions (such as 401(k) or TSP) and the standard deduction.",
    inputs: [
      { id: "income", label: "Gross income" },
      { id: "pretax", label: "Pre-tax deductions" },
    ],
    outputs: [
      { id: "tax", label: "Tax", format: "money" },
      { id: "taxable", label: "Taxable income", format: "money" },
      { id: "effective", label: "Effective rate", format: "percent" },
      { id: "marginal", label: "Top bracket", format: "percent" },
    ],
    params: [
      statusParam,
      yearParam,
      { key: "itemized", label: "Itemized deductions (0 = standard)", type: "money", default: 0 },
    ],
    compute: (i, p) => {
      const gross = sum(i["income"]);
      const status = String(p["status"]) as FilingStatus;
      const year = federalYear(p);
      const itemized = num(p["itemized"]);
      const t =
        itemized > 0
          ? federalIncomeTax(gross - sum(i["pretax"]), status, year, itemized)
          : federalIncomeTax(gross - sum(i["pretax"]), status, year);
      return {
        tax: t.tax,
        taxable: t.taxableIncome,
        effective: gross > 0 ? t.tax / gross : 0,
        marginal: t.marginalRate,
      };
    },
  },
  payroll_tax: {
    label: "FICA (Social Security & Medicare)",
    group: "Taxes",
    description:
      "The employee's share of FICA: 6.2% Social Security up to the wage base, 1.45% Medicare, and the additional 0.9% Medicare on wages above $200,000 ($250,000 married filing jointly).",
    inputs: [{ id: "wages", label: "Wages" }],
    outputs: [
      { id: "total", label: "Total", format: "money" },
      { id: "ss", label: "Social Security", format: "money" },
      { id: "medicare", label: "Medicare", format: "money" },
      { id: "additional", label: "Additional Medicare", format: "money" },
      { id: "effective", label: "Effective rate", format: "percent" },
    ],
    params: [statusParam, yearParam],
    compute: (i, p) => {
      const wages = sum(i["wages"]);
      const t = payrollTax(wages, String(p["status"]) as FilingStatus, federalYear(p));
      return {
        total: t.total,
        ss: t.socialSecurity,
        medicare: t.medicare,
        additional: t.additionalMedicare,
        effective: wages > 0 ? t.total / wages : 0,
      };
    },
  },
  fers: {
    label: "FERS retirement",
    group: "Taxes",
    description:
      "A federal employee's FERS retirement contribution, withheld from basic pay: 0.8%, 3.1% or 4.4% by when you were first hired (higher for law enforcement, firefighters and air traffic controllers), or your own rate. It is not pre-tax: income tax is still worked out on the full pay.",
    inputs: [{ id: "pay", label: "Basic pay" }],
    outputs: [
      { id: "contribution", label: "Contribution", format: "money" },
      { id: "rest", label: "Pay after FERS", format: "money" },
    ],
    params: [
      {
        key: "plan",
        label: "Plan",
        type: "select",
        options: [
          ...FERS_PLANS.map((f) => ({ value: f.value, label: f.label })),
          { value: "custom", label: "My own rate" },
        ],
        default: "fers_frae",
      },
      { key: "rate", label: "Rate (my own)", type: "percent", default: 4.4 },
    ],
    compute: (i, p) => {
      const pay = sum(i["pay"]);
      const plan = FERS_PLANS.find((f) => f.value === String(p["plan"]));
      const contribution = fersContribution(pay, plan ? plan.rate : num(p["rate"]) / 100);
      return { contribution, rest: pay - contribution };
    },
  },
  state_tax: {
    label: "State income tax",
    group: "Taxes",
    description:
      "Maryland, Washington DC, or Virginia income tax for 2026 (2027 uses the 2026 figures until new ones are out), with your own deduction or brackets if you like. Or set your own flat rate or brackets for anywhere else.",
    inputs: [
      { id: "income", label: "Income" },
      { id: "pretax", label: "Pre-tax deductions" },
    ],
    outputs: [
      { id: "tax", label: "Tax", format: "money" },
      { id: "taxable", label: "Taxable income", format: "money" },
      { id: "effective", label: "Effective rate", format: "percent" },
      { id: "marginal", label: "Top bracket", format: "percent" },
    ],
    params: [
      {
        key: "state",
        label: "State",
        type: "select",
        options: [
          ...STATE_CHOICES,
          { value: "custom_flat", label: "My own flat rate" },
          { value: "custom_brackets", label: "My own brackets" },
        ],
        default: "VA",
      },
      dmvYearParam,
      statusParam,
      {
        key: "deduction",
        label: "Standard deduction (filled in for the state; blank = official)",
        type: "text",
        default: "",
      },
      { key: "rate", label: "Flat rate (my own)", type: "percent", default: 5 },
      {
        key: "brackets",
        label: "Brackets: from %, … (filled in for the state; change them to use your own)",
        type: "text",
        default: "",
      },
    ],
    // Choosing Maryland, DC or Virginia (or changing the filing status or year) fills in that
    // state's official deduction and brackets, unless the user had typed their own there.
    autofill: (before, after) => {
      const next = stateFigureText(after);
      const previous = stateFigureText(before);
      const untouched = (key: "deduction" | "brackets") => {
        const value = String(before[key] ?? "").trim();
        return value === "" || (previous !== null && value === previous[key]);
      };
      const fill: Record<string, ParamValue> = {};
      for (const key of ["deduction", "brackets"] as const) {
        // Never over what this change itself typed in that box, nor over the user's own figures.
        if (after[key] !== before[key] || !untouched(key)) continue;
        // Your own rate or brackets start from blank, not from the state's figures.
        fill[key] = next ? next[key] : "";
      }
      return fill;
    },
    compute: (i, p) => {
      const gross = sum(i["income"]);
      const income = gross - sum(i["pretax"]);
      const state = String(p["state"] ?? "custom_flat");
      const deductionText = String(p["deduction"] ?? "").trim();
      const deduction = deductionText === "" ? null : Number(deductionText.replace(/[$,\s]/g, ""));
      if (deduction !== null && !Number.isFinite(deduction))
        throw new Error("The deduction is not a number.");
      const bracketText = String(p["brackets"] ?? "").trim();
      const brackets = bracketText === "" ? null : parseBrackets(bracketText);
      if (bracketText !== "" && !brackets) {
        throw new Error("Write brackets as “from percent” pairs, such as 0 2, 3000 3, 17000 5.75.");
      }
      let tax: number;
      let marginal: number;
      if (state === "custom_flat" || state === "custom_brackets" || !isStateCode(state)) {
        if (!isStateCode(state) && state !== "custom_flat" && state !== "custom_brackets") {
          throw new Error("Choose Maryland, DC, Virginia, or your own rate.");
        }
        const taxable = Math.max(0, income - (deduction ?? 0));
        if (state === "custom_brackets") {
          if (!brackets) throw new Error("Enter your brackets.");
          ({ tax, marginal } = bracketTax(taxable, brackets));
        } else {
          tax = (taxable * num(p["rate"])) / 100;
          marginal = taxable > 0 ? num(p["rate"]) / 100 : 0;
        }
        return { tax, taxable, effective: gross > 0 ? tax / gross : 0, marginal };
      }
      const t = stateTax(
        income,
        state,
        String(p["status"] ?? "single") as FilingStatus,
        dmvYear(p),
        {
          standardDeduction: deduction,
          brackets,
        },
      );
      return {
        tax: t.tax,
        taxable: t.taxableIncome,
        effective: gross > 0 ? t.tax / gross : 0,
        marginal: t.marginalRate,
      };
    },
  },
  local_tax: {
    label: "County / city income tax",
    group: "Taxes",
    description:
      "Maryland's county income tax (all 23 counties and Baltimore City, 2026 rates from the Comptroller), worked out on Maryland taxable income. DC and Virginia have no local income tax. Or set your own rate or brackets.",
    inputs: [
      { id: "income", label: "Income" },
      { id: "pretax", label: "Pre-tax deductions" },
    ],
    outputs: [
      { id: "tax", label: "Tax", format: "money" },
      { id: "effective", label: "Effective rate", format: "percent" },
    ],
    params: [
      {
        key: "place",
        label: "Where you live",
        type: "select",
        options: [
          ...MARYLAND_COUNTIES.map((c) => ({ value: c.id, label: `${c.name}, MD` })),
          { value: "none", label: "DC or Virginia (no local income tax)" },
          { value: "custom", label: "My own rate" },
          { value: "custom_brackets", label: "My own brackets" },
        ],
        default: "montgomery",
      },
      dmvYearParam,
      statusParam,
      { key: "rate", label: "Rate (my own)", type: "percent", default: 1 },
      { key: "brackets", label: "Brackets: from %, … (my own)", type: "text", default: "" },
    ],
    compute: (i, p) => {
      const gross = sum(i["income"]);
      const income = gross - sum(i["pretax"]);
      const place = String(p["place"] ?? "custom");
      let tax: number;
      if (place === "none") tax = 0;
      else if (place === "custom") tax = (Math.max(0, income) * num(p["rate"])) / 100;
      else if (place === "custom_brackets") {
        const brackets = parseBrackets(String(p["brackets"] ?? ""));
        if (!brackets)
          throw new Error("Write brackets as “from percent” pairs, such as 0 1, 50000 2.");
        tax = bracketTax(Math.max(0, income), brackets).tax;
      } else {
        const t = marylandLocalTax(
          income,
          place,
          String(p["status"] ?? "single") as FilingStatus,
          dmvYear(p),
        );
        if (!t) throw new Error("That place is not in the list any more; choose it again.");
        tax = t.tax;
      }
      return { tax, effective: gross > 0 ? tax / gross : 0 };
    },
  },
  vehicle_tax: {
    label: "Vehicle tax (Virginia)",
    group: "Taxes",
    description:
      "Virginia's yearly personal property tax on a car: the county's rate per $100 of value, less the state's relief on the first $20,000, plus any yearly fees (registration, local decal). Maryland and DC have no yearly car tax.",
    inputs: [],
    outputs: [
      { id: "total", label: "Per year", format: "money" },
      { id: "relief", label: "State relief", format: "money" },
    ],
    params: [
      {
        key: "locality",
        label: "County",
        type: "select",
        options: [
          ...VIRGINIA_VEHICLE_LOCALITIES.map((l) => ({ value: l.id, label: l.name })),
          { value: "custom", label: "My own rate and relief" },
        ],
        default: "fairfax_county",
      },
      { key: "value", label: "Vehicle value", type: "money", default: 20_000 },
      { key: "rate", label: "Rate per $100 (my own)", type: "number", default: 4 },
      {
        key: "relief",
        label: "Relief on first $20,000 (my own, or where not confirmed)",
        type: "percent",
        default: 0,
      },
      { key: "fees", label: "Yearly fees", type: "money", default: 0 },
    ],
    compute: (_i, p) => {
      const locality = VIRGINIA_VEHICLE_LOCALITIES.find((l) => l.id === String(p["locality"]));
      const t = virginiaVehicleTax({
        value: num(p["value"]),
        ratePer100: locality ? locality.ratePer100 : num(p["rate"]),
        // A locality whose relief was not confirmed uses the one entered from the bill.
        reliefPercent: locality?.reliefPercent ?? num(p["relief"]),
        exemptUpTo: locality?.exemptUpTo ?? 0,
        yearlyFees: num(p["fees"]),
      });
      return { total: t.total, relief: t.relief };
    },
  },
  result: {
    label: "Result",
    group: "Results",
    description: "Shows what is wired in, per year and per month.",
    inputs: [{ id: "value", label: "Value" }],
    outputs: [],
    params: [],
    compute: () => ({}),
  },
} satisfies Record<string, NodeDef>;

export type NodeKind = keyof typeof NODE_DEFS;
export const nodeDef = (kind: NodeKind): NodeDef => NODE_DEFS[kind] as NodeDef;

export function newNode(kind: NodeKind, id: string, x: number, y: number): SandboxNode {
  const params: Record<string, ParamValue> = {};
  for (const p of nodeDef(kind).params) params[p.key] = p.default;
  // Starting settings fill in what they imply (a state tax node starts with its state's figures).
  return { id, kind, x, y, params: withAutofill(kind, params, params) };
}

export interface Evaluation {
  /** Each node's outputs. */
  outputs: Record<string, Record<string, number>>;
  /** Each node's inputs (as added up), for showing on result nodes. */
  inputs: Record<string, Record<string, number>>;
  errors: Record<string, string>;
}

/** Works the whole graph out. Nodes caught in a loop, or whose maths fails, get an error. */
export function evaluate(graph: Graph, data: DataValues = {}): Evaluation {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, Wire[]>();
  for (const w of graph.wires) {
    if (!byId.has(w.from.node) || !byId.has(w.to.node)) continue;
    incoming.set(w.to.node, [...(incoming.get(w.to.node) ?? []), w]);
  }
  const result: Evaluation = { outputs: {}, inputs: {}, errors: {} };
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return !(id in result.errors);
    if (state.get(id) === "visiting") return false;
    state.set(id, "visiting");
    const node = byId.get(id)!;
    const def = nodeDef(node.kind);
    const inputs: Record<string, number[]> = {};
    let ok = true;
    for (const w of incoming.get(id) ?? []) {
      if (!visit(w.from.node)) {
        ok = false;
        continue;
      }
      const value = result.outputs[w.from.node]?.[w.from.port];
      if (value === undefined) continue;
      inputs[w.to.port] = [...(inputs[w.to.port] ?? []), value];
    }
    result.inputs[id] = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, sum(v)]));
    if (!ok) {
      result.errors[id] ??= "Part of a loop, or fed by a node with a problem.";
      state.set(id, "done");
      return false;
    }
    try {
      result.outputs[id] = def.compute(inputs, node.params, { data });
    } catch (e) {
      result.errors[id] = e instanceof Error ? e.message : "Could not work this out.";
    }
    state.set(id, "done");
    return !(id in result.errors);
  };
  for (const n of graph.nodes) visit(n.id);
  return result;
}

/** Whether a new wire would close a loop (the target already feeds the source). */
export function wouldLoop(graph: Graph, fromNode: string, toNode: string): boolean {
  if (fromNode === toNode) return true;
  const next = new Map<string, string[]>();
  for (const w of graph.wires) next.set(w.from.node, [...(next.get(w.from.node) ?? []), w.to.node]);
  const seen = new Set<string>();
  const stack = [toNode];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === fromNode) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

let counter = 0;
export const newId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A ready-made graph: pay to take-home pay after taxes and a retirement contribution. */
export function takeHomeTemplate(): Graph {
  const n = (
    kind: NodeKind,
    id: string,
    x: number,
    y: number,
    params: Record<string, ParamValue> = {},
  ) => {
    const node = newNode(kind, id, x, y);
    node.params = { ...node.params, ...params };
    return node;
  };
  const nodes = [
    n("income", "pay", 20, 260, { amount: 85_000, period: "yearly" }),
    n("percent", "k401", 310, 40, { rate: 5 }),
    n("federal_tax", "fed", 600, 0),
    n("payroll_tax", "fica", 600, 400),
    n("state_tax", "state", 600, 690, { state: "VA" }),
    n("subtract", "net", 900, 300),
    n("per_period", "split", 1190, 160),
    n("result", "out", 1190, 420),
  ];
  nodes[1]!.title = "401(k) / TSP (pre-tax)";
  nodes[5]!.title = "Take-home pay";
  const wire = (id: string, fn: string, fp: string, tn: string, tp: string): Wire => ({
    id,
    from: { node: fn, port: fp },
    to: { node: tn, port: tp },
  });
  return {
    nodes,
    wires: [
      wire("w1", "pay", "yearly", "k401", "value"),
      wire("w2", "pay", "yearly", "fed", "income"),
      wire("w3", "k401", "part", "fed", "pretax"),
      wire("w4", "pay", "yearly", "fica", "wages"),
      wire("w5", "pay", "yearly", "state", "income"),
      wire("w13", "k401", "part", "state", "pretax"),
      wire("w6", "pay", "yearly", "net", "from"),
      wire("w7", "fed", "tax", "net", "minus"),
      wire("w8", "fica", "total", "net", "minus"),
      wire("w9", "state", "tax", "net", "minus"),
      wire("w10", "k401", "part", "net", "minus"),
      wire("w11", "net", "result", "split", "yearly"),
      wire("w12", "net", "result", "out", "value"),
    ],
  };
}
