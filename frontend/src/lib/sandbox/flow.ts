import { bracketTax, parseBrackets } from "./brackets";
import {
  marylandLocalTax,
  stateTax,
  VIRGINIA_VEHICLE_LOCALITIES,
  virginiaVehicleTax,
  type StateCode,
  type TaxYear,
} from "./dmvTaxes";
import { federalIncomeTax, payrollTax, type FilingStatus } from "./taxes";

/**
 * The cash-flow map: money moving between buckets. Unlike the maths sandbox, a node here is a place
 * money goes (income, a tax, a pre-tax deduction, spending, savings, what is left) and a connection
 * carries an amount from one to another.
 *
 * - Income has an amount the user sets.
 * - A connection into pre-tax, spending, or savings carries the amount the user sets on it.
 * - A connection into a tax works itself out: the tax on the income it comes from, after that
 *   income's pre-tax deductions.
 * - A connection into a bucket carries whatever its source has not sent elsewhere (its remainder);
 *   a bucket fed by several sources holds the sum of their remainders.
 * - Any other node holds the total of what flows into it, and can send money on.
 *
 * All amounts are yearly dollars.
 */

export type FlowKind = "income" | "tax" | "pretax" | "spending" | "savings" | "leftover";
export type FlowTaxType = "federal" | "fica" | "fers" | "state" | "local" | "vehicle" | "custom";

/** A tax the user describes: a percentage, a fixed yearly amount, or brackets. */
export interface CustomTax {
  mode: "percent" | "fixed" | "brackets";
  /** Percent of income, for "percent". */
  rate?: number;
  /** Dollars per year, for "fixed". */
  amount?: number;
  /** "from percent" pairs, for "brackets" (such as "0 2, 3000 3, 17000 5.75"). */
  brackets?: string;
  /** Take the income's pre-tax deductions off first (default yes). */
  afterPretax?: boolean;
}

export interface FlowNode {
  id: string;
  kind: FlowKind;
  label: string;
  x: number;
  y: number;
  /** Income: what it brings in per year. */
  amount?: number;
  /** Size on the map, when the user made it bigger than the default. */
  w?: number;
  h?: number;
  tax?: {
    type: FlowTaxType;
    status?: FilingStatus;
    year?: TaxYear;
    state?: StateCode;
    county?: string;
    /** Vehicle tax. */
    locality?: string;
    vehicleValue?: number;
    /** The relief percent from the bill, for a locality whose relief was not confirmed. */
    vehicleRelief?: number;
    /** A flat rate (percent) instead of the official figures, for state or local tax. */
    customRate?: number | null;
    /** The "custom" tax type. */
    custom?: CustomTax;
  };
  /** Savings and pre-tax accounts: expected yearly growth, percent. */
  apy?: number;
  /**
   * Pre-tax: also free of Social Security and Medicare (a health plan or HSA through payroll is;
   * a 401(k) or TSP is not).
   */
  ficaExempt?: boolean;
}

export interface FlowLink {
  id: string;
  from: string;
  to: string;
  /** Yearly amount the user set (ignored where it is worked out: taxes and what's left). */
  amount?: number;
}

export interface FlowGraph {
  nodes: FlowNode[];
  links: FlowLink[];
}

export interface FlowResult {
  /** Each node's yearly amount. */
  nodeAmounts: Record<string, number>;
  /** Each connection's yearly amount. */
  linkAmounts: Record<string, number>;
  /** Nodes that send out more than they have. */
  overspent: Record<string, number>;
  totals: {
    income: number;
    taxes: number;
    pretax: number;
    spending: number;
    savings: number;
    leftover: number;
    /** Taxes as a share of income. */
    effectiveTaxRate: number;
    /** Pre-tax plus savings as a share of income. */
    savingsRate: number;
  };
}

const FERS_RATE = 0.044;

/** A connection is worked out (not set by hand) when it goes into a tax or a bucket. */
export function isAutoLink(graph: FlowGraph, link: FlowLink): boolean {
  const target = graph.nodes.find((n) => n.id === link.to);
  return target?.kind === "tax" || target?.kind === "leftover";
}

/**
 * The tax a node charges on income of `income` with `pretax` of pre-tax deductions, of which
 * `ficaExempt` are also free of Social Security and Medicare.
 */
export function taxFor(node: FlowNode, income: number, pretax: number, ficaExempt = 0): number {
  const t = node.tax;
  if (!t) return 0;
  const status = t.status ?? "single";
  const year = t.year ?? 2026;
  const afterPretax = Math.max(0, income - pretax);
  switch (t.type) {
    case "federal":
      return federalIncomeTax(afterPretax, status, 2026).tax;
    case "fica":
      return payrollTax(Math.max(0, income - ficaExempt), status, 2026).total;
    case "fers":
      return Math.round(income * FERS_RATE * 100) / 100;
    case "state":
      if (t.customRate != null) return Math.round(afterPretax * t.customRate) / 100;
      return stateTax(afterPretax, t.state ?? "VA", status, year).tax;
    case "local":
      if (t.customRate != null) return Math.round(afterPretax * t.customRate) / 100;
      if ((t.state ?? "MD") !== "MD") return 0;
      return marylandLocalTax(afterPretax, t.county ?? "montgomery", status, year)?.tax ?? 0;
    case "custom": {
      const c = t.custom ?? { mode: "percent", rate: 0 };
      const base = c.afterPretax === false ? Math.max(0, income) : afterPretax;
      if (c.mode === "fixed") return Math.max(0, c.amount ?? 0);
      if (c.mode === "brackets") {
        const brackets = parseBrackets(c.brackets ?? "");
        return brackets ? Math.round(bracketTax(base, brackets).tax * 100) / 100 : 0;
      }
      return Math.round(base * (c.rate ?? 0)) / 100;
    }
    case "vehicle": {
      const place = VIRGINIA_VEHICLE_LOCALITIES.find(
        (l) => l.id === (t.locality ?? "fairfax_county"),
      );
      return virginiaVehicleTax({
        value: t.vehicleValue ?? 0,
        ratePer100: t.customRate ?? place?.ratePer100 ?? 0,
        reliefPercent: place?.reliefPercent ?? t.vehicleRelief ?? 0,
        exemptUpTo: place?.exemptUpTo ?? 0,
      }).total;
    }
  }
}

export function computeFlow(graph: FlowGraph): FlowResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const links = graph.links.filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to);
  const outgoing = (id: string) => links.filter((l) => l.from === id);
  const incoming = (id: string) => links.filter((l) => l.to === id);

  const nodeCache = new Map<string, number>();
  const linkCache = new Map<string, number>();
  const visiting = new Set<string>();

  const pretaxOf = (sourceId: string, ficaOnly = false): number =>
    outgoing(sourceId)
      .filter((l) => byId.get(l.to)!.kind === "pretax" && (!ficaOnly || byId.get(l.to)!.ficaExempt))
      .reduce((n, l) => n + Math.max(0, l.amount ?? 0), 0);

  const linkAmount = (link: FlowLink): number => {
    const cached = linkCache.get(link.id);
    if (cached !== undefined) return cached;
    const target = byId.get(link.to)!;
    let value: number;
    if (target.kind === "tax") {
      value = taxFor(target, nodeAmount(link.from), pretaxOf(link.from), pretaxOf(link.from, true));
    } else if (target.kind === "leftover") {
      // The source's remainder: what it has, less everything it sends anywhere but buckets. When
      // it feeds several buckets, they share the remainder equally.
      const all = outgoing(link.from);
      const buckets = all.filter((l) => byId.get(l.to)!.kind === "leftover").length;
      const spent = all.reduce(
        (n, l) => n + (byId.get(l.to)!.kind === "leftover" ? 0 : linkAmount(l)),
        0,
      );
      value = Math.max(0, nodeAmount(link.from) - spent) / Math.max(1, buckets);
    } else {
      value = Math.max(0, link.amount ?? 0);
    }
    linkCache.set(link.id, value);
    return value;
  };

  function nodeAmount(id: string): number {
    const cached = nodeCache.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id)!;
    if (visiting.has(id)) return 0; // a loop: count it once
    visiting.add(id);
    let value: number;
    if (node.kind === "income") value = Math.max(0, node.amount ?? 0);
    else value = incoming(id).reduce((n, l) => n + linkAmount(l), 0);
    visiting.delete(id);
    nodeCache.set(id, value);
    return value;
  }

  const nodeAmounts: Record<string, number> = {};
  for (const n of graph.nodes) nodeAmounts[n.id] = round2(nodeAmount(n.id));
  const linkAmounts: Record<string, number> = {};
  for (const l of links) linkAmounts[l.id] = round2(linkAmount(l));

  const overspent: Record<string, number> = {};
  for (const n of graph.nodes) {
    const out = outgoing(n.id).reduce((s, l) => s + (linkAmounts[l.id] ?? 0), 0);
    if (out - nodeAmounts[n.id]! > 0.5) overspent[n.id] = round2(out - nodeAmounts[n.id]!);
  }

  const total = (kind: FlowKind) =>
    graph.nodes.filter((n) => n.kind === kind).reduce((s, n) => s + nodeAmounts[n.id]!, 0);
  // What's left counts only what stays there (not what it passes on).
  const leftover = graph.nodes
    .filter((n) => n.kind === "leftover")
    .reduce(
      (s, n) =>
        s +
        Math.max(
          0,
          nodeAmounts[n.id]! - outgoing(n.id).reduce((x, l) => x + linkAmounts[l.id]!, 0),
        ),
      0,
    );
  const income = total("income");
  const taxes = total("tax");
  const pretax = total("pretax");
  const savings = total("savings");
  return {
    nodeAmounts,
    linkAmounts,
    overspent,
    totals: {
      income,
      taxes,
      pretax,
      spending: total("spending"),
      savings,
      leftover,
      effectiveTaxRate: income > 0 ? taxes / income : 0,
      savingsRate: income > 0 ? (pretax + savings) / income : 0,
    },
  };
}

/**
 * Balances of the savings and pre-tax accounts over the years, with what flows in each year added
 * month by month and growing at the account's yearly rate (compounded monthly).
 */
export function projectGrowth(
  graph: FlowGraph,
  result: FlowResult,
  years: number,
): Array<{ year: number; balances: Record<string, number>; total: number }> {
  const accounts = graph.nodes.filter((n) => n.kind === "savings" || n.kind === "pretax");
  const balance: Record<string, number> = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  const points = [{ year: 0, balances: { ...balance }, total: 0 }];
  for (let y = 1; y <= years; y++) {
    for (let m = 0; m < 12; m++) {
      for (const a of accounts) {
        const monthlyRate = (a.apy ?? 0) / 100 / 12;
        balance[a.id] = balance[a.id]! * (1 + monthlyRate) + (result.nodeAmounts[a.id] ?? 0) / 12;
      }
    }
    const rounded = Object.fromEntries(Object.entries(balance).map(([k, v]) => [k, round2(v)]));
    points.push({
      year: y,
      balances: rounded,
      total: round2(Object.values(balance).reduce((s, v) => s + v, 0)),
    });
  }
  return points;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The starting map: pay, its taxes, pre-tax deductions, and where the rest goes. */
export function defaultFlow(): FlowGraph {
  const node = (n: FlowNode): FlowNode => n;
  return {
    nodes: [
      node({ id: "pay", kind: "income", label: "Gross pay", x: 48, y: 384, amount: 100_000 }),
      node({
        id: "fed",
        kind: "tax",
        label: "Federal tax",
        x: 408,
        y: 0,
        tax: { type: "federal" },
      }),
      node({
        id: "state",
        kind: "tax",
        label: "Virginia tax",
        x: 408,
        y: 144,
        tax: { type: "state", state: "VA" },
      }),
      node({
        id: "fica",
        kind: "tax",
        label: "FICA (Social Security & Medicare)",
        x: 408,
        y: 288,
        tax: { type: "fica" },
      }),
      node({ id: "k401", kind: "pretax", label: "401(k) / TSP", x: 408, y: 456, apy: 7 }),
      node({ id: "hsa", kind: "pretax", label: "HSA", x: 408, y: 600, apy: 6, ficaExempt: true }),
      node({
        id: "health",
        kind: "pretax",
        label: "Health plan",
        x: 408,
        y: 744,
        ficaExempt: true,
      }),
      node({ id: "left", kind: "leftover", label: "Take-home pay", x: 768, y: 384 }),
      node({
        id: "car",
        kind: "tax",
        label: "Car tax (Fairfax)",
        x: 1152,
        y: 48,
        tax: { type: "vehicle", locality: "fairfax_county", vehicleValue: 20_000 },
      }),
      node({ id: "rent", kind: "spending", label: "Rent", x: 1152, y: 192 }),
      node({ id: "food", kind: "spending", label: "Food", x: 1152, y: 336 }),
      node({ id: "gas", kind: "spending", label: "Gas", x: 1152, y: 480 }),
      node({ id: "hysa", kind: "savings", label: "High-yield savings", x: 1152, y: 624, apy: 4 }),
    ],
    links: [
      { id: "l1", from: "pay", to: "fed" },
      { id: "l2", from: "pay", to: "state" },
      { id: "l3", from: "pay", to: "fica" },
      { id: "l4", from: "pay", to: "k401", amount: 6_000 },
      { id: "l5", from: "pay", to: "hsa", amount: 4_150 },
      { id: "l6", from: "pay", to: "health", amount: 2_600 },
      { id: "l7", from: "pay", to: "left" },
      { id: "l8", from: "left", to: "car" },
      { id: "l9", from: "left", to: "rent", amount: 24_000 },
      { id: "l10", from: "left", to: "food", amount: 7_200 },
      { id: "l11", from: "left", to: "gas", amount: 2_400 },
      { id: "l12", from: "left", to: "hysa", amount: 12_000 },
    ],
  };
}
