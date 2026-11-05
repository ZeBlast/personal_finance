import { describe, expect, it } from "vitest";
import type { ScenarioComparison } from "../types/planning";
import { formatDay } from "./time";
import {
  comparisonSentence,
  describeAdjustment,
  forecastedSeries,
  signedMoney,
  tileChangeText,
  unmatchedNote,
} from "./scenarios";

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
    ).toBe("With “Rent goes up”: lowest $200.00 lower, end $400.00 lower than your plan.");
    const same = (low: number, end: number) =>
      comparisonSentence(
        {
          scenario: { name: "X" },
          lowestChangeMinor: low,
          endChangeMinor: end,
        } as ScenarioComparison,
        "USD",
      );
    expect(same(0, 500)).toBe(
      "With “X”: lowest the same, end $5.00 higher compared with your plan.",
    );
    expect(same(0, 0)).toBe("With “X”: the lowest and the end balance are the same as your plan.");
  });
});

describe("forecastedSeries", () => {
  it("hides payments the forecast always skips", () => {
    const s = (merchant: string, accountNames: string[]) => ({ merchant, accountNames });
    const series = [
      s("Rent", ["Checking"]),
      s("Gym", ["Checking"]),
      s("Netflix", ["Visa"]),
      s("Hulu", ["Store card"]),
      s("Odd", ["Unknown"]),
    ];
    const shown = forecastedSeries(
      series,
      [" gym "],
      [
        { name: "Checking", type: "depository" },
        { name: "Visa", type: "credit" },
        { name: "Store card", type: "credit" },
      ],
      [
        { name: "Visa", statement: {} },
        { name: "Store card", statement: null },
      ],
    );
    expect(shown.map((x) => x.merchant)).toEqual(["Rent", "Netflix"]);
  });
});

describe("tileChangeText", () => {
  it("reads as a difference, not a balance", () => {
    expect(tileChangeText(-108_037, "USD")).toBe("$1,080.37 lower with the scenario");
    expect(tileChangeText(500, "USD")).toBe("$5.00 higher with the scenario");
    expect(tileChangeText(0, "USD")).toBe("Same with the scenario");
  });
});

describe("unmatchedNote", () => {
  it("tells a past change from one that finds nothing", () => {
    const oneOff = { kind: "one_off", label: "x", date: "2026-11-01", amountMinor: -5 } as const;
    expect(unmatchedNote(oneOff, "2026-11-05", 60)).toBe(
      "This change is before today, so it doesn't affect the forecast.",
    );
    expect(unmatchedNote({ ...oneOff, date: "2026-12-01" }, "2026-11-05", 60)).toBe(
      "This change doesn't match anything in the next 60 days.",
    );
    expect(unmatchedNote({ kind: "goal", goalId: 1, forecast: null }, "2026-11-05", 30)).toBe(
      "This change doesn't match anything in the next 30 days.",
    );
  });
});

describe("signedMoney", () => {
  it("signs changes and leaves zero plain", () => {
    expect(signedMoney(5_000, "USD")).toBe("+$50.00");
    expect(signedMoney(-5_000, "USD")).toBe("−$50.00");
    expect(signedMoney(0, "USD")).toBe("$0.00");
  });
});
