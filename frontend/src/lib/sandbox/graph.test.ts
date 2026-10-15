import { describe, expect, it } from "vitest";
import {
  evaluate,
  newNode,
  nodeAccent,
  snapToGrid,
  takeHomeTemplate,
  toYearly,
  withAutofill,
  wouldLoop,
  type Graph,
} from "./graph";
import { stateTax } from "./dmvTaxes";
import { federalIncomeTax, payrollTax } from "./taxes";

const wire = (id: string, fn: string, fp: string, tn: string, tp: string) => ({
  id,
  from: { node: fn, port: fp },
  to: { node: tn, port: tp },
});

describe("the sandbox graph", () => {
  it("turns any pay period into a yearly amount", () => {
    expect(toYearly(25, "hourly", 40)).toBe(52_000);
    expect(toYearly(2_000, "biweekly")).toBe(52_000);
    expect(toYearly(1_500, "monthly")).toBe(18_000);
  });

  it("adds up several wires into one input, and subtracts", () => {
    const a = newNode("income", "a", 0, 0);
    a.params = { amount: 50_000, period: "yearly", hours: 40 };
    const b = newNode("income", "b", 0, 0);
    b.params = { amount: 1_000, period: "monthly", hours: 40 };
    const rent = newNode("expense", "rent", 0, 0);
    rent.params = { amount: 1_500, period: "monthly" };
    const net = newNode("subtract", "net", 0, 0);
    const g: Graph = {
      nodes: [a, b, rent, net],
      wires: [
        wire("1", "a", "yearly", "net", "from"),
        wire("2", "b", "yearly", "net", "from"),
        wire("3", "rent", "yearly", "net", "minus"),
      ],
    };
    expect(evaluate(g).outputs["net"]).toEqual({ result: 50_000 + 12_000 - 18_000 });
  });

  it("works out take-home pay after taxes and a pre-tax contribution", () => {
    const g = takeHomeTemplate();
    const r = evaluate(g);
    const pay = 85_000;
    const k401 = pay * 0.05;
    const fed = federalIncomeTax(pay - k401, "single", 2026).tax;
    const fica = payrollTax(pay, "single", 2026).total;
    const state = stateTax(pay - k401, "VA", "single", 2026).tax;
    expect(r.errors).toEqual({});
    expect(r.outputs["fed"]!["tax"]).toBe(fed);
    expect(r.outputs["net"]!["result"]).toBeCloseTo(pay - fed - fica - state - k401, 6);
    expect(r.outputs["split"]!["monthly"]).toBeCloseTo(r.outputs["net"]!["result"]! / 12, 6);
    expect(r.inputs["out"]!["value"]).toBeCloseTo(r.outputs["net"]!["result"]!, 6);
  });

  it("refuses loops, and reports nodes caught in one or dividing by zero", () => {
    const g = takeHomeTemplate();
    expect(wouldLoop(g, "net", "pay")).toBe(true);
    expect(wouldLoop(g, "pay", "out")).toBe(false);
    expect(wouldLoop(g, "net", "net")).toBe(true);
    const x = newNode("add", "x", 0, 0);
    const y = newNode("add", "y", 0, 0);
    const looped = evaluate({
      nodes: [x, y],
      wires: [wire("1", "x", "sum", "y", "values"), wire("2", "y", "sum", "x", "values")],
    });
    expect(Object.keys(looped.errors).sort()).toEqual(["x", "y"]);
    const d = newNode("divide", "d", 0, 0);
    expect(evaluate({ nodes: [d], wires: [] }).errors["d"]).toMatch(/zero/);
  });

  it("works out Maryland state and county tax, a custom flat rate, and custom brackets", () => {
    const pay = newNode("income", "pay", 0, 0);
    pay.params = { amount: 100_000, period: "yearly", hours: 40 };
    const md = newNode("state_tax", "md", 0, 0);
    md.params = withAutofill("state_tax", md.params, {
      ...md.params,
      state: "MD",
      status: "single",
    });
    const county = newNode("local_tax", "county", 0, 0);
    county.params = { ...county.params, place: "montgomery", status: "single" };
    // Settings change as on the page: what they imply is filled in (or cleared) as well.
    const set = (node: ReturnType<typeof newNode>, change: Record<string, string | number>) => {
      node.params = withAutofill("state_tax", node.params, { ...node.params, ...change });
    };
    const flat = newNode("state_tax", "flat", 0, 0);
    set(flat, { state: "custom_flat", rate: 5, deduction: "10000" });
    const own = newNode("state_tax", "own", 0, 0);
    set(own, { state: "custom_brackets", brackets: "0 1, 50000 2" });
    const r = evaluate({
      nodes: [pay, md, county, flat, own],
      wires: ["md", "county", "flat", "own"].map((id, n) =>
        wire(String(n), "pay", "yearly", id, "income"),
      ),
    });
    expect(r.errors).toEqual({});
    const mdTax = stateTax(100_000, "MD", "single", 2026);
    expect(r.outputs["md"]!["tax"]).toBe(mdTax.tax);
    expect(r.outputs["county"]!["tax"]).toBeCloseTo(mdTax.taxableIncome * 0.032, 2);
    expect(r.outputs["flat"]!["tax"]).toBe(4_500);
    expect(r.outputs["own"]!["tax"]).toBe(500 + 1_000);
  });

  it("explains brackets it cannot read, and old places that are gone", () => {
    const pay = newNode("income", "pay", 0, 0);
    const bad = newNode("state_tax", "bad", 0, 0);
    bad.params = withAutofill("state_tax", bad.params, {
      ...bad.params,
      state: "custom_brackets",
      brackets: "lots",
    });
    const old = newNode("state_tax", "old", 0, 0);
    old.params = { ...old.params, state: "CA" };
    const r = evaluate({
      nodes: [pay, bad, old],
      wires: [
        wire("1", "pay", "yearly", "bad", "income"),
        wire("2", "pay", "yearly", "old", "income"),
      ],
    });
    expect(r.errors["bad"]).toMatch(/from percent/);
    expect(r.errors["old"]).toMatch(/Maryland, DC, Virginia/);
  });

  it("works out Virginia's car tax with the state relief", () => {
    const car = newNode("vehicle_tax", "car", 0, 0);
    car.params = { ...car.params, locality: "fairfax_county", value: 30_000, fees: 0 };
    expect(evaluate({ nodes: [car], wires: [] }).outputs["car"]).toEqual({
      total: 923.14,
      relief: 447.86,
    });
  });

  it("uses Loudoun's 2026 relief, and the user's relief where a locality's is not confirmed", () => {
    const loudoun = newNode("vehicle_tax", "l", 0, 0);
    loudoun.params = { ...loudoun.params, locality: "loudoun", value: 20_000, fees: 0 };
    // $3.09 per $100 on $20,000 is $618; 41% relief takes off $253.38.
    expect(evaluate({ nodes: [loudoun], wires: [] }).outputs["l"]).toEqual({
      total: 364.62,
      relief: 253.38,
    });
    const arlington = newNode("vehicle_tax", "a", 0, 0);
    arlington.params = { ...arlington.params, locality: "arlington", value: 10_000, relief: 50 };
    expect(evaluate({ nodes: [arlington], wires: [] }).outputs["a"]).toEqual({
      total: 250,
      relief: 250,
    });
  });

  it("fills in a state's official deduction and brackets, keeping the user's own", () => {
    const node = newNode("state_tax", "s", 0, 0);
    // A new node starts in Virginia, already filled in.
    expect(node.params).toMatchObject({
      state: "VA",
      deduction: "8750",
      brackets: "0 2, 3000 3, 5000 5, 17000 5.75",
    });
    // Choosing Maryland swaps in Maryland's; married filing jointly then takes its own.
    const md = withAutofill("state_tax", node.params, { ...node.params, state: "MD" });
    expect(md["deduction"]).toBe("3350");
    expect(String(md["brackets"])).toMatch(/^0 2, 1000 3/);
    const married = withAutofill("state_tax", md, { ...md, status: "married_joint" });
    expect(married["deduction"]).toBe("6700");
    expect(String(married["brackets"])).toMatch(/150000 5,/);
    // A deduction the user typed stays when the state changes; untouched brackets still update.
    const typed = { ...md, deduction: "5000" };
    const dc = withAutofill("state_tax", typed, { ...typed, state: "DC" });
    expect(dc["deduction"]).toBe("5000");
    expect(String(dc["brackets"])).toMatch(/^0 4, 10000 6/);
    // Filled-in figures give the same tax as the official ones.
    const filled = evaluate({ nodes: [{ ...node, params: md }], wires: [] });
    expect(filled.errors["s"]).toBeUndefined();
    // Your own rate starts from blank boxes, but keeps a deduction you typed.
    expect(withAutofill("state_tax", md, { ...md, state: "custom_flat" })).toMatchObject({
      deduction: "",
      brackets: "",
    });
    expect(withAutofill("state_tax", typed, { ...typed, state: "custom_flat" })).toMatchObject({
      deduction: "5000",
      brackets: "",
    });
  });

  it("snaps to the grid, and shows spending in yellow", () => {
    expect(snapToGrid(37)).toBe(48);
    expect(snapToGrid(-13)).toBe(-24);
    expect(snapToGrid(48)).toBe(48);
    const expense = newNode("expense", "e", 0, 0);
    const income = newNode("income", "i", 0, 0);
    const data = newNode("data", "d", 0, 0);
    expect(nodeAccent(expense)).toBe("#eab308");
    expect(nodeAccent(data)).toBe("#eab308"); // "From my data" starts on spending
    expect(nodeAccent({ ...data, params: { ...data.params, source: "income" } })).toBe("#16a34a");
    expect(nodeAccent(income)).toBe("#16a34a");
  });

  it("works out FICA and FERS from pay", () => {
    const pay = newNode("income", "pay", 0, 0);
    pay.params = { amount: 100_000, period: "yearly", hours: 40 };
    const fica = newNode("payroll_tax", "fica", 0, 0);
    const fers = newNode("fers", "fers", 0, 0);
    const r = evaluate({
      nodes: [pay, fica, fers],
      wires: [
        wire("1", "pay", "yearly", "fica", "wages"),
        wire("2", "pay", "yearly", "fers", "pay"),
      ],
    });
    expect(r.outputs["fica"]).toMatchObject({ total: 7_650, additional: 0, effective: 0.0765 });
    expect(r.outputs["fers"]).toEqual({ contribution: 4_400, rest: 95_600 });
  });

  it("uses figures from the user's data", () => {
    const n = newNode("data", "s", 0, 0);
    n.params = { source: "spending", months: "6" };
    expect(evaluate({ nodes: [n], wires: [] }, { "spending:6": 42_000 }).outputs["s"]).toEqual({
      yearly: 42_000,
    });
  });
});
