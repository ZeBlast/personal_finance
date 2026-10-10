import { describe, expect, it } from "vitest";
import { stateTax, virginiaVehicleTax } from "./dmvTaxes";
import { computeFlow, defaultFlow, isAutoLink, projectGrowth, type FlowGraph } from "./flow";
import { federalIncomeTax, payrollTax } from "./taxes";

describe("the cash-flow map", () => {
  it("works out the taxes, what's left, and where it goes", () => {
    const g = defaultFlow();
    const r = computeFlow(g);
    const pay = 100_000;
    const pretax = 6_000 + 4_150 + 2_600;
    const fed = federalIncomeTax(pay - pretax, "single", 2026).tax;
    const va = stateTax(pay - pretax, "VA", "single", 2026).tax;
    // A 401(k) still owes FICA; the HSA and health plan do not.
    const fica = payrollTax(pay - 4_150 - 2_600, "single", 2026).total;
    expect(r.linkAmounts["l1"]).toBe(fed);
    expect(r.linkAmounts["l2"]).toBe(va);
    expect(r.linkAmounts["l3"]).toBe(fica);
    const takeHome = Math.round((pay - fed - va - fica - pretax) * 100) / 100;
    expect(r.nodeAmounts["left"]).toBeCloseTo(takeHome, 2);
    const car = virginiaVehicleTax({
      value: 20_000,
      ratePer100: 4.57,
      reliefPercent: 49,
      exemptUpTo: 1000,
    }).total;
    expect(r.linkAmounts["l8"]).toBe(car);
    expect(r.totals.taxes).toBeCloseTo(fed + va + fica + car, 2);
    expect(r.totals.leftover).toBeCloseTo(takeHome - car - 24_000 - 7_200 - 2_400 - 12_000, 2);
    expect(r.overspent).toEqual({});
  });

  it("says which links are worked out and flags a bucket that sends out more than it has", () => {
    const g: FlowGraph = {
      nodes: [
        { id: "a", kind: "income", label: "Pay", x: 0, y: 0, amount: 1_000 },
        { id: "b", kind: "spending", label: "Rent", x: 0, y: 0 },
        { id: "t", kind: "tax", label: "Tax", x: 0, y: 0, tax: { type: "state", customRate: 10 } },
      ],
      links: [
        { id: "x", from: "a", to: "b", amount: 1_200 },
        { id: "y", from: "a", to: "t" },
      ],
    };
    expect(isAutoLink(g, g.links[0]!)).toBe(false);
    expect(isAutoLink(g, g.links[1]!)).toBe(true);
    const r = computeFlow(g);
    expect(r.linkAmounts["y"]).toBe(100);
    expect(r.overspent).toEqual({ a: 300 });
  });

  it("adds up the remainders of every source flowing into a bucket, and shares one source's among its buckets", () => {
    const g: FlowGraph = {
      nodes: [
        { id: "a", kind: "income", label: "Job", x: 0, y: 0, amount: 1_000 },
        { id: "b", kind: "income", label: "Side gig", x: 0, y: 0, amount: 500 },
        { id: "rent", kind: "spending", label: "Rent", x: 0, y: 0 },
        { id: "pot", kind: "leftover", label: "Bucket", x: 0, y: 0 },
      ],
      links: [
        { id: "1", from: "a", to: "rent", amount: 600 },
        { id: "2", from: "a", to: "pot" },
        { id: "3", from: "b", to: "pot" },
      ],
    };
    expect(computeFlow(g).nodeAmounts["pot"]).toBe(400 + 500);
    // A second bucket fed by the same job: the job's $400 remainder is shared, not counted twice.
    g.nodes.push({ id: "pot2", kind: "leftover", label: "Bucket 2", x: 0, y: 0 });
    g.links.push({ id: "4", from: "a", to: "pot2" });
    const r = computeFlow(g);
    expect(r.nodeAmounts["pot"]).toBe(200 + 500);
    expect(r.nodeAmounts["pot2"]).toBe(200);
    expect(r.overspent).toEqual({});
  });

  it("charges a custom tax as a percentage, a fixed amount, or by brackets", async () => {
    const { taxFor } = await import("./flow");
    const node = (custom: object) =>
      ({
        id: "t",
        kind: "tax",
        label: "Custom",
        x: 0,
        y: 0,
        tax: { type: "custom", custom },
      }) as never;
    // $50,000 pay with $5,000 of pre-tax deductions.
    expect(taxFor(node({ mode: "percent", rate: 2 }), 50_000, 5_000)).toBe(900);
    expect(taxFor(node({ mode: "percent", rate: 2, afterPretax: false }), 50_000, 5_000)).toBe(
      1_000,
    );
    expect(taxFor(node({ mode: "fixed", amount: 120 }), 50_000, 5_000)).toBe(120);
    expect(taxFor(node({ mode: "brackets", brackets: "0 1, 10000 2" }), 50_000, 5_000)).toBe(
      100 + 700,
    );
    expect(taxFor(node({ mode: "brackets", brackets: "nonsense" }), 50_000, 5_000)).toBe(0);
  });

  it("projects savings growth month by month", () => {
    const g: FlowGraph = {
      nodes: [
        { id: "a", kind: "income", label: "Pay", x: 0, y: 0, amount: 12_000 },
        { id: "s", kind: "savings", label: "Savings", x: 0, y: 0, apy: 0 },
      ],
      links: [{ id: "x", from: "a", to: "s", amount: 1_200 }],
    };
    const r = computeFlow(g);
    expect(projectGrowth(g, r, 2).map((p) => p.total)).toEqual([0, 1_200, 2_400]);
    g.nodes[1]!.apy = 12;
    const grown = projectGrowth(g, computeFlow(g), 1)[1]!.total;
    expect(grown).toBeGreaterThan(1_200);
    expect(grown).toBeLessThan(1_270);
  });
});
