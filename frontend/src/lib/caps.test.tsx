// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapMeter } from "../components/charts/CapMeter";
import { BudgetsPage } from "../pages/BudgetsPage";
import { fakeBackend } from "../test/fakeBackend";
import type { Budget } from "../types/analytics";
import {
  capDetail,
  daysLeftIn,
  historyWords,
  reportVerdict,
  sortCaps,
  suggestedCap,
  totalExpected,
} from "./caps";
import { announceDataChanged } from "./syncEvents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const money = (minor: number) => `$${minor / 100}`;
const b = {
  status: "ok" as const,
  remainingMinor: 10000,
  availableMinor: 30000,
  projectedMinor: null,
};

describe("caps in words", () => {
  it("lists what needs attention first", () => {
    const sorted = sortCaps([
      { status: "ok" as const, percentUsed: 90 },
      { status: "over" as const, percentUsed: 120 },
      { status: "ok" as const, percentUsed: 95 },
      { status: "risk" as const, percentUsed: 50 },
    ]);
    expect(sorted.map((c) => c.status + c.percentUsed)).toEqual([
      "over120",
      "risk50",
      "ok95",
      "ok90",
    ]);
  });

  it("counts the days left, today included, only in the current month", () => {
    expect(daysLeftIn("2026-11", "2026-11-30")).toBe(1);
    expect(daysLeftIn("2026-11", "2026-11-01")).toBe(30);
    expect(daysLeftIn("2026-10", "2026-11-01")).toBeNull();
  });

  it("says how each state stands", () => {
    expect(capDetail({ ...b, status: "over", remainingMinor: -500 }, 3, money)).toBe("by $5");
    expect(capDetail({ ...b, status: "full", remainingMinor: 0 }, 3, money)).toBe(
      "Nothing left this month",
    );
    expect(capDetail({ ...b, status: "risk", projectedMinor: 35000 }, 10, money)).toBe(
      "Could end near $350, $50 over",
    );
    expect(capDetail(b, 10, money)).toBe("$100 left, about $10 a day");
    expect(capDetail(b, null, money)).toBe("$100 left");
  });

  it("does not count a subcategory's pace twice", () => {
    expect(
      totalExpected([
        { categoryId: 1, parentId: null, expectedMinor: 100 },
        { categoryId: 2, parentId: 1, expectedMinor: 40 },
        { categoryId: 3, parentId: 9, expectedMinor: 5 },
      ]),
    ).toBe(105);
  });

  it("suggests a cap from a typical month, rounded up", () => {
    expect(suggestedCap({ averageMinor: 41234, spentMinor: 0 })).toBe(42000);
    expect(suggestedCap({ averageMinor: 0, spentMinor: 1500 })).toBe(2000);
  });

  it("sums up a cap's earlier months, leaving out months with none", () => {
    const history = [
      { month: "2026-08", spentMinor: 900, capMinor: null },
      { month: "2026-09", spentMinor: 100, capMinor: 500 },
      { month: "2026-10", spentMinor: 900, capMinor: 500 },
    ];
    expect(historyWords(history)).toBe("Within the cap in 1 of 2 months.");
    expect(historyWords([])).toBe("No earlier months with a cap.");
  });

  it("names what went over in the report", () => {
    const item = (label: string, status: "over" | "ok", remainingMinor: number) => ({
      label,
      status,
      remainingMinor,
    });
    expect(reportVerdict([item("Food", "ok", 100), item("Gas", "ok", 100)], money)).toEqual({
      held: "Stayed within all 2 caps.",
      over: null,
    });
    expect(reportVerdict([item("Food", "over", -500), item("Gas", "ok", 100)], money)).toEqual({
      held: "1 of 2 caps held.",
      over: "Over: Food by $5.",
    });
  });
});

describe("the meter", () => {
  const meter = (spentMinor: number, capMinor: number, extra = {}) =>
    render(
      <CapMeter
        spentMinor={spentMinor}
        capMinor={capMinor}
        color="#123456"
        label="Food cap"
        description="reading"
        {...extra}
      />,
    );

  it("reads out in words", () => {
    meter(100, 200);
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe("reading");
  });

  it("widens its scale past the cap, so going over shows", () => {
    meter(300, 200);
    expect(screen.getByRole("meter").getAttribute("aria-valuemax")).toBe("300");
  });

  it("marks today's even pace only when there is one", () => {
    meter(100, 200, { expectedMinor: 50 });
    expect(screen.getByTestId("pace-mark").style.left).toBe("25%");
    cleanup();
    meter(100, 200);
    expect(screen.queryByTestId("pace-mark")).toBeNull();
  });
});

describe("the caps page", () => {
  const cap = (over: Partial<Budget>): Budget => ({
    id: 1,
    categoryId: 1,
    categoryName: "Food",
    categoryColor: "#123456",
    parentId: null,
    amountMinor: 30000,
    rollover: "off",
    carryInMinor: 0,
    availableMinor: 30000,
    spentMinor: 10000,
    remainingMinor: 20000,
    percentUsed: 33,
    overspent: false,
    fund: null,
    repeats: true,
    inherited: false,
    status: "ok",
    expectedMinor: 15000,
    projectedMinor: 20000,
    history: [],
    ...over,
  });

  it("shows new figures as soon as the data changes anywhere in the app", async () => {
    let spent = 10000;
    fakeBackend({});
    const fetchFake = vi.mocked(fetch);
    const answer = fetchFake.getMockImplementation()!;
    fetchFake.mockImplementation(async (url, init) => {
      if (String(url).includes("/api/budgets?")) {
        return new Response(
          JSON.stringify({
            month: "2026-11",
            budgets: [cap({ spentMinor: spent, remainingMinor: 30000 - spent })],
            totals: { budgetedMinor: 30000, spentMinor: spent, remainingMinor: 30000 - spent },
            unbudgetedSpendingMinor: 0,
            uncapped: [],
          }),
          { status: 200 },
        );
      }
      return answer(url as string, init);
    });
    render(
      <MemoryRouter>
        <BudgetsPage />
      </MemoryRouter>,
    );
    await screen.findAllByText("$100.00");
    spent = 25000;
    act(() => announceDataChanged());
    await waitFor(() => expect(screen.getAllByText("$250.00").length).toBeGreaterThan(0));
  });
});
