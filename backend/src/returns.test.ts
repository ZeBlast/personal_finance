import { describe, expect, it } from "vitest";
import { modifiedDietz, periodReturn } from "./services/returns.service.js";

describe("investment returns", () => {
  it("are the gain with contributions taken out", () => {
    // $10,000 grows to $11,000 with no money added: 10%.
    const r = modifiedDietz("2026-01-01", "2026-12-31", 1_000_000, 1_100_000, []);
    expect(r.gainMinor).toBe(100_000);
    expect(r.returnRate).toBeCloseTo(0.1, 6);
    // The same end value after putting in $1,000 halfway: the market made nothing.
    const flat = modifiedDietz("2026-01-01", "2026-12-31", 1_000_000, 1_100_000, [
      { date: "2026-07-02", amountMinor: 100_000 },
    ]);
    expect(flat.gainMinor).toBe(0);
    expect(flat.returnRate).toBe(0);
    expect(flat.netContributedMinor).toBe(100_000);
  });

  it("weight a contribution by how long it was invested", () => {
    // $1,000 in at the start of a period with $0 before, worth $1,100 at the end: 10%.
    const r = modifiedDietz("2026-01-01", "2026-12-31", 0, 110_000, [
      { date: "2026-01-01", amountMinor: 100_000 },
    ]);
    expect(r.returnRate).toBeCloseTo(0.1, 6);
    // Put in on the last day: nothing to measure against.
    expect(
      modifiedDietz("2026-01-01", "2026-12-31", 0, 100_000, [
        { date: "2026-12-31", amountMinor: 100_000 },
      ]).returnRate,
    ).toBeNull();
  });

  it("give a yearly rate for periods over a year", () => {
    const r = modifiedDietz("2024-01-01", "2026-01-01", 1_000_000, 1_210_000, []);
    expect(r.returnRate).toBeCloseTo(0.21, 6);
    expect(r.annualRate).toBeCloseTo(0.1, 2);
    expect(modifiedDietz("2026-01-01", "2026-06-30", 100, 110, []).annualRate).toBeNull();
  });

  it("count an account that starts inside the period from its first value", () => {
    const a = {
      id: 1,
      name: "TSP",
      values: [
        { date: "2026-03-01", valueMinor: 500_000 },
        { date: "2026-12-31", valueMinor: 600_000 },
      ],
      flows: [{ date: "2026-06-01", amountMinor: 50_000 }],
    };
    const r = periodReturn([a], "2026-01-01", "2026-12-31")!;
    // Start $0; the first $5,000 enters as money in, then $500 more: $500 gained.
    expect(r.startValueMinor).toBe(0);
    expect(r.netContributedMinor).toBe(550_000);
    expect(r.gainMinor).toBe(50_000);
    expect(r.returnRate).toBeGreaterThan(0.09);
    expect(periodReturn([{ ...a, values: [] }], "2026-01-01", "2026-12-31")).toBeNull();
    // Only a value on the last day: nothing to measure yet.
    expect(
      periodReturn(
        [{ ...a, values: [{ date: "2026-12-31", valueMinor: 1 }] }],
        "2026-01-01",
        "2026-12-31",
      ),
    ).toBeNull();
  });
});
