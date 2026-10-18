import { describe, expect, it } from "vitest";
import type { Budget } from "../types/analytics";
import { budgetNotes } from "./BudgetsPage";

const base: Budget = {
  id: 1,
  categoryId: 2,
  categoryName: "Shopping",
  categoryColor: null,
  parentId: null,
  amountMinor: 50_000,
  rollover: "off",
  carryInMinor: 0,
  availableMinor: 50_000,
  spentMinor: 20_000,
  remainingMinor: 30_000,
  percentUsed: 40,
  overspent: false,
  fund: null,
};

describe("budget notes", () => {
  it("say nothing for a plain monthly budget", () => {
    expect(budgetNotes(base)).toEqual([]);
  });

  it("explain what carried in and what carries on", () => {
    expect(
      budgetNotes({
        ...base,
        rollover: "all",
        carryInMinor: -10_000,
        availableMinor: 40_000,
        spentMinor: 60_000,
        remainingMinor: -20_000,
      }),
    ).toEqual(["$500.00 − $100.00 overspent last month", "$200.00 over comes off next month"]);
    // Only leftovers carry: an overspent month carries nothing.
    expect(budgetNotes({ ...base, rollover: "leftover", remainingMinor: -5_000 })).toEqual([
      "$0.00 carries into next month",
    ]);
  });

  it("show a fund's monthly amount", () => {
    const notes = budgetNotes({
      ...base,
      rollover: "leftover",
      fund: {
        targetMinor: 120_000,
        targetDate: "2026-12-15",
        monthsLeft: 4,
        suggestedMinor: 30_000,
        reached: false,
      },
    });
    expect(notes[1]).toMatch(
      /^Fund: \$1,200\.00 by .+ · set aside \$300\.00 a month \(4 months\)$/,
    );
  });
});
