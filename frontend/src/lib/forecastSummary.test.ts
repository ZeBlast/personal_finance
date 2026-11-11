import { describe, expect, it } from "vitest";
import type { ForecastDay, ForecastEvent } from "../types/planning";
import {
  biggestOut,
  bySource,
  filterEvents,
  forecastTotals,
  NO_FILTER,
  weeklyBreakdown,
} from "./forecastSummary";

const ev = (label: string, amountMinor: number, source: ForecastEvent["source"]): ForecastEvent =>
  ({ label, amountMinor, source }) as ForecastEvent;

/** Wed Nov 11 to Tue Nov 17, 2026: the first week ends on Sunday the 15th. */
const days: ForecastDay[] = [
  { date: "2026-11-11", balanceMinor: 100_000, changeMinor: 0, events: [] },
  {
    date: "2026-11-12",
    balanceMinor: 40_000,
    changeMinor: -60_000,
    events: [ev("Rent", -55_000, "recurring"), ev("Caps", -5_000, "cap_holdback")],
  },
  {
    date: "2026-11-13",
    balanceMinor: -10_000,
    changeMinor: -50_000,
    events: [ev("Visa bill", -50_000, "card_bill")],
  },
  { date: "2026-11-14", balanceMinor: -10_000, changeMinor: 0, events: [] },
  {
    date: "2026-11-15",
    balanceMinor: 190_000,
    changeMinor: 200_000,
    events: [ev("Acme Payroll", 200_000, "recurring")],
  },
  {
    date: "2026-11-16",
    balanceMinor: 188_000,
    changeMinor: -2_000,
    events: [ev("Gym", -2_000, "expected")],
  },
  { date: "2026-11-17", balanceMinor: 188_000, changeMinor: 0, events: [] },
];

describe("the forecast's totals", () => {
  it("add up money in and out, and find the first day below zero", () => {
    expect(forecastTotals(days, "2026-11-11")).toEqual({
      inMinor: 200_000,
      outMinor: 112_000,
      netMinor: 88_000,
      firstBelowZero: "2026-11-13",
      daysUntilBelowZero: 2,
    });
  });

  it("say never when the balance stays up", () => {
    const fine = days.map((d) => ({ ...d, balanceMinor: Math.abs(d.balanceMinor) }));
    expect(forecastTotals(fine, "2026-11-11")).toMatchObject({
      firstBelowZero: null,
      daysUntilBelowZero: null,
    });
    expect(forecastTotals([], "2026-11-11")).toMatchObject({ inMinor: 0, outMinor: 0 });
  });
});

describe("week by week", () => {
  it("splits at Monday, with each week's in, out, end and lowest", () => {
    expect(weeklyBreakdown(days)).toEqual([
      {
        start: "2026-11-11",
        end: "2026-11-15",
        inMinor: 200_000,
        outMinor: 110_000,
        endBalanceMinor: 190_000,
        lowestMinor: -10_000,
        events: 3,
      },
      {
        start: "2026-11-16",
        end: "2026-11-17",
        inMinor: 0,
        outMinor: 2_000,
        endBalanceMinor: 188_000,
        lowestMinor: 188_000,
        events: 1,
      },
    ]);
  });
});

describe("by kind and biggest", () => {
  it("totals each kind, the most money moved first", () => {
    expect(bySource(days)).toEqual([
      { source: "recurring", inMinor: 200_000, outMinor: 55_000, count: 2 },
      { source: "card_bill", inMinor: 0, outMinor: 50_000, count: 1 },
      { source: "cap_holdback", inMinor: 0, outMinor: 5_000, count: 1 },
      { source: "expected", inMinor: 0, outMinor: 2_000, count: 1 },
    ]);
  });

  it("lists the largest payments out, never the hold-back or money in", () => {
    expect(biggestOut(days, 2).map((e) => `${e.date} ${e.label}`)).toEqual([
      "2026-11-12 Rent",
      "2026-11-13 Visa bill",
    ]);
  });
});

describe("filtering what is coming", () => {
  it("shows everything but the hold-back by default, keeping each day's balance", () => {
    const all = filterEvents(days, NO_FILTER);
    expect(all.map((d) => d.date)).toEqual([
      "2026-11-12",
      "2026-11-13",
      "2026-11-15",
      "2026-11-16",
    ]);
    expect(all[0]!.events.map((e) => e.label)).toEqual(["Rent"]);
    expect(all[0]!.balanceMinor).toBe(40_000);
  });

  it("narrows by direction, kind and words", () => {
    const labels = (f: Partial<typeof NO_FILTER>) =>
      filterEvents(days, { ...NO_FILTER, ...f }).flatMap((d) => d.events.map((e) => e.label));
    expect(labels({ direction: "in" })).toEqual(["Acme Payroll"]);
    expect(labels({ direction: "out" })).toEqual(["Rent", "Visa bill", "Gym"]);
    expect(labels({ source: "recurring" })).toEqual(["Rent", "Acme Payroll"]);
    expect(labels({ text: " visa " })).toEqual(["Visa bill"]);
    expect(labels({ direction: "in", source: "card_bill" })).toEqual([]);
    expect(labels({ range: { start: "2026-11-13", end: "2026-11-15" } })).toEqual([
      "Visa bill",
      "Acme Payroll",
    ]);
  });
});
