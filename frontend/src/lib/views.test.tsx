// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnnotatedForecast, stepLine } from "../components/views/AnnotatedForecast";
import { flowPath } from "../components/views/CashFlowMap";
import { yearSentence, type YearReport } from "../pages/YearPage";
import type { Forecast } from "../types/planning";
import { hasFrame, readAppearance, appearanceConfig } from "../widgets/appearance";
import type { DailyBrief } from "../widgets/DailyBriefWidget";
import {
  attentionItems,
  cashFlowModel,
  heatmapWeeks,
  lowestOf,
  lowestTile,
  merchantChange,
  sortMerchants,
  spreadLabels,
  stackColumn,
  weekdayAverages,
  withExtraSpend,
} from "./views";

afterEach(cleanup);

const money = (minor: number) => `$${minor / 100}`;
const row = (key: string, spendingMinor: number, incomeMinor = 0) => ({
  key,
  label: key,
  color: null,
  spendingMinor,
  incomeMinor,
});

const forecast: Forecast = {
  currency: "USD",
  today: "2026-11-01",
  startBalanceMinor: 100_000,
  accountsCounted: 1,
  days: [
    { date: "2026-11-01", balanceMinor: 100_000, changeMinor: 0, events: [] },
    {
      date: "2026-11-02",
      balanceMinor: 40_000,
      changeMinor: -60_000,
      events: [{ label: "Rent", amountMinor: -60_000, source: "recurring" }],
    },
    { date: "2026-11-03", balanceMinor: 40_000, changeMinor: 0, events: [] },
  ],
  lowest: { date: "2026-11-02", balanceMinor: 40_000 },
  endBalanceMinor: 40_000,
  capHoldBack: { included: false, totalMinor: 0, caps: [] },
};

describe("the forecast's lowest tile", () => {
  it("keeps the lowest point when it is not today", () => {
    expect(lowestTile(forecast)).toEqual({
      date: "2026-11-02",
      balanceMinor: 40_000,
      afterToday: false,
    });
  });

  it("uses the lowest of the days after today when the lowest is today", () => {
    const low = { ...forecast, lowest: { date: "2026-11-01", balanceMinor: 100_000 } };
    expect(lowestTile(low)).toEqual({ date: "2026-11-02", balanceMinor: 40_000, afterToday: true });
  });

  it("falls back to the overall lowest when there are no days after today", () => {
    const only = {
      ...forecast,
      days: forecast.days.slice(0, 1),
      lowest: { date: "2026-11-01", balanceMinor: 100_000 },
    };
    expect(lowestTile(only)).toMatchObject({ date: "2026-11-01", afterToday: false });
  });
});

describe("the what-if", () => {
  it("takes an extra purchase off that day and every day after", () => {
    const tried = withExtraSpend(forecast.days, 50_000, "2026-11-02");
    expect(tried.map((d) => d.balanceMinor)).toEqual([100_000, -10_000, -10_000]);
    expect(lowestOf(tried)).toMatchObject({ date: "2026-11-02", balanceMinor: -10_000 });
  });
});

describe("the annotated forecast", () => {
  it("holds a balance until the next day, as steps", () => {
    expect(
      stepLine([
        { x: 0, y: 10 },
        { x: 5, y: 20 },
      ]),
    ).toBe("M0,10H5V20");
  });

  it("names the lowest point and marks days money moves", () => {
    render(<AnnotatedForecast forecast={forecast} />);
    screen.getByText(/Lowest \$400/);
    expect(screen.getAllByTestId("event-mark")).toHaveLength(1);
    expect(screen.queryByTestId("what-if-line")).toBeNull();
  });
});

describe("what needs the user", () => {
  const brief = {
    staleAccounts: [{ name: "Bank", updatedAt: null, needsSignIn: true }],
  } as DailyBrief;

  it("puts cash going below zero first, and words each thing", () => {
    const items = attentionItems({
      forecast: { ...forecast, lowest: { date: "2026-11-02", balanceMinor: -500 } },
      brief,
      capsOver: 2,
      capsAtRisk: 1,
      toReview: 3,
      money,
    });
    expect(items.map((i) => i.text)).toEqual([
      expect.stringContaining("Cash goes to $-5"),
      "Bank needs signing in again",
      "2 spending caps are over",
      "1 spending cap is heading over",
      "3 transactions to review",
    ]);
  });

  it("is empty when all is well", () => {
    expect(
      attentionItems({ forecast, brief: null, capsOver: 0, capsAtRisk: 0, toReview: 0, money }),
    ).toEqual([]);
  });
});

describe("the cash-flow map", () => {
  it("shows what income left over as saved, so both sides add up", () => {
    const m = cashFlowModel([row("Pay", 0, 1000), row("Food", 300), row("Rent", 500)]);
    expect(m.targets.map((t) => [t.label, t.amountMinor])).toEqual([
      ["Rent", 500],
      ["Food", 300],
      ["Saved", 200],
    ]);
    expect(m.totalMinor).toBe(1000);
  });

  it("shows what income did not cover as coming from elsewhere", () => {
    const m = cashFlowModel([row("Pay", 0, 100), row("Rent", 500)]);
    expect(m.sources.map((s) => [s.label, s.amountMinor])).toEqual([
      ["Pay", 100],
      ["From savings or credit", 400],
    ]);
  });

  it("folds small categories together, keeping the total", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`C${i}`, 100 - i));
    const m = cashFlowModel(rows);
    expect(m.targets).toHaveLength(10); // nine, and everything else
    expect(m.targets.reduce((sum, t) => sum + t.amountMinor, 0)).toBe(m.spendingMinor);
  });

  it("gets a category that both pays in and spends onto both sides", () => {
    const m = cashFlowModel([row("Other", 50, 80)]);
    expect(m.sources[0]!.amountMinor).toBe(80);
    expect(m.targets.map((t) => t.label)).toEqual(["Other", "Saved"]);
  });

  it("stacks bars by share, with gaps", () => {
    const m = cashFlowModel([row("A", 300), row("B", 100)]);
    const bands = stackColumn(m.targets, 400, 110, 10);
    expect(bands[0]).toMatchObject({ y: 0, height: 75 });
    expect(bands[1]).toMatchObject({ y: 85, height: 25 });
  });

  it("keeps labels apart and on the chart, in order", () => {
    expect(spreadLabels([50, 52, 54], 18, 200)).toEqual([50, 68, 86]);
    expect(spreadLabels([190, 195, 199], 18, 200)).toEqual([155, 173, 191]);
    expect(spreadLabels([1], 18, 200)).toEqual([9]);
  });

  it("draws a closed band of the right thickness", () => {
    expect(flowPath(0, 0, 10, 20, 5)).toBe("M0,0C5,0 5,20 10,20V25C5,25 5,5 0,5Z");
  });
});

describe("the heatmap", () => {
  // 2026-11-04 is a Wednesday.
  const weeks = heatmapWeeks(
    [
      { key: "2026-11-01", spendingMinor: 100 },
      { key: "2026-11-02", spendingMinor: 200 },
      { key: "2026-11-03", spendingMinor: 300 },
      { key: "2026-11-04", spendingMinor: 90000 },
    ],
    "2026-11-04",
    2,
  );

  it("lays out whole weeks from Sunday, marking days not reached", () => {
    expect(weeks).toHaveLength(2);
    expect(weeks[1]![0]!.date).toBe("2026-11-01");
    expect(weeks[1]![3]).toMatchObject({ date: "2026-11-04", future: false });
    expect(weeks[1]![4]!.future).toBe(true);
  });

  it("shades by rank, so one huge day leaves the others visible", () => {
    expect(weeks[1]!.slice(0, 4).map((d) => d.level)).toEqual([1, 2, 3, 4]);
    expect(weeks[0]![0]!.level).toBe(0);
  });

  it("averages each weekday over the days that have happened", () => {
    const averages = weekdayAverages(weeks);
    expect(averages[0]).toEqual({ day: "Sunday", averageMinor: 50 });
    expect(averages[3]).toEqual({ day: "Wednesday", averageMinor: 45000 });
    expect(averages[6]).toEqual({ day: "Saturday", averageMinor: 0 });
  });
});

describe("merchant order", () => {
  const list = [
    { merchant: "Big", totalMinor: 900, recentAverageMinor: 100, earlierAverageMinor: 200 },
    { merchant: "Rising", totalMinor: 300, recentAverageMinor: 90, earlierAverageMinor: 10 },
  ];
  it("sorts by size or by growth", () => {
    expect(sortMerchants(list, "biggest")[0]!.merchant).toBe("Big");
    expect(sortMerchants(list, "growing")[0]!.merchant).toBe("Rising");
    expect(merchantChange(list[1]!)).toBe(80);
  });
});

describe("the year's sentence", () => {
  it("uses only what is known", () => {
    const year = {
      incomeMinor: 1000,
      spendingMinor: 400,
      savedMinor: 600,
      savingsRatePercent: 60,
      netWorth: { startMinor: null, endMinor: null, changeMinor: null },
    } as YearReport;
    expect(yearSentence(year, money)).toBe("$10 came in and $4 went out, saving 60% of income.");
    expect(
      yearSentence({ ...year, netWorth: { startMinor: 1, endMinor: 0, changeMinor: -100 } }, money),
    ).toContain("net worth down $1");
  });
});

describe("a widget's border", () => {
  it("follows the widget unless the user chooses otherwise", () => {
    expect(hasFrame("auto", undefined)).toBe(false);
    expect(hasFrame("auto", true)).toBe(true);
    expect(hasFrame("always", undefined)).toBe(true);
    expect(hasFrame("never", true)).toBe(false);
  });

  it("is saved only when chosen, and survives bad values", () => {
    expect(appearanceConfig({ title: "", hideHeader: false, accent: "", frame: "auto" })).toEqual(
      {},
    );
    const saved = appearanceConfig({ title: "", hideHeader: false, accent: "", frame: "never" });
    expect(readAppearance(saved).frame).toBe("never");
    expect(readAppearance({ _frame: "sideways" }).frame).toBe("auto");
  });
});
