import { describe, expect, it } from "vitest";
import type { ScenarioComparison } from "../types/planning";
import { formatDay } from "./time";
import { comparisonSentence, describeAdjustment, signedMoney } from "./scenarios";

const names = {
  series: new Map([["k", "City Apartments"]]),
  planned: new Map([[3, "Gym"]]),
  goals: new Map([[7, "Holiday"]]),
};

describe("describeAdjustment", () => {
  it("describes a one-off amount", () => {
    expect(
      describeAdjustment(
        { kind: "one_off", label: "Car repair", date: "2026-10-15", amountMinor: -50_000 },
        "USD",
        names,
      ),
    ).toBe(`Car repair: −$500.00 on ${formatDay("2026-10-15")}`);
  });

  it("describes stopping and changing a regular payment", () => {
    expect(
      describeAdjustment(
        {
          kind: "change_series",
          target: { seriesKey: "k" },
          fromDate: "2026-11-01",
          amountMinor: null,
        },
        "USD",
        names,
      ),
    ).toBe(`Stop City Apartments from ${formatDay("2026-11-01")}`);
    expect(
      describeAdjustment(
        {
          kind: "change_series",
          target: { plannedId: 3 },
          fromDate: "2026-11-01",
          amountMinor: 4_000,
        },
        "USD",
        names,
      ),
    ).toBe(`Change Gym to $40.00 from ${formatDay("2026-11-01")}`);
  });

  it("describes a new regular amount and a goal contribution", () => {
    expect(
      describeAdjustment(
        {
          kind: "recurring",
          label: "Side job",
          amountMinor: 20_000,
          cadence: "monthly",
          startDate: "2026-11-01",
          endDate: null,
        },
        "USD",
        names,
      ),
    ).toBe(`Side job: +$200.00 every month from ${formatDay("2026-11-01")}`);
    expect(
      describeAdjustment(
        { kind: "goal", goalId: 7, forecast: { monthlyMinor: 30_000, day: 5 } },
        "USD",
        names,
      ),
    ).toBe("Holiday: set aside $300.00 a month, on day 5");
    expect(describeAdjustment({ kind: "goal", goalId: 7, forecast: null }, "USD", names)).toBe(
      "Holiday: stop counting its monthly contribution",
    );
  });
});

describe("comparisonSentence", () => {
  it("says how the lowest and last days differ", () => {
    expect(
      comparisonSentence(
        {
          scenario: { name: "Rent goes up" },
          lowestChangeMinor: -20_000,
          endChangeMinor: -40_000,
        } as ScenarioComparison,
        "USD",
      ),
    ).toBe("With “Rent goes up”: lowest −$200.00, at the end −$400.00 compared with your plan.");
  });
});

describe("signedMoney", () => {
  it("signs changes and leaves zero plain", () => {
    expect(signedMoney(5_000, "USD")).toBe("+$50.00");
    expect(signedMoney(-5_000, "USD")).toBe("−$50.00");
    expect(signedMoney(0, "USD")).toBe("$0.00");
  });
});
