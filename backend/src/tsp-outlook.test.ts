import { describe, expect, it } from "vitest";
import { mixReturns, yearlyFundReturns } from "./services/tsp-outlook.service.js";

const prices = (symbol: string, byYear: Record<number, number>) =>
  Object.entries(byYear).flatMap(([year, price]) => [
    { symbol, date: `${year}-06-01`, price: price * 0.9 },
    { symbol, date: `${year}-12-31`, price },
  ]);

describe("a TSP mix's past years", () => {
  it("are each fund's year-end to year-end change, whole years only", () => {
    const r = yearlyFundReturns(prices("TSP-C", { 2024: 100, 2025: 110, 2026: 120 }), 2026);
    expect([...r.get("TSP-C")!.entries()]).toEqual([[2025, expect.closeTo(0.1, 6)]]);
  });

  it("weight the funds by the mix, with the nearest L fund standing in before one existed", () => {
    const all = [
      ...prices("TSP-G", { 2010: 10, 2011: 10.2, 2012: 10.4 }),
      ...prices("TSP-F", { 2010: 10, 2011: 10, 2012: 10 }),
      ...prices("TSP-C", { 2010: 10, 2011: 12, 2012: 12 }),
      ...prices("TSP-S", { 2010: 10, 2011: 10, 2012: 10 }),
      ...prices("TSP-I", { 2010: 10, 2011: 10, 2012: 10 }),
      ...prices("TSP-L2040", { 2010: 10, 2011: 11, 2012: 11 }),
      // L 2050 starts in 2011, so 2011 has no return for it yet.
      ...prices("TSP-L2050", { 2011: 10, 2012: 10.5 }),
    ];
    const returns = yearlyFundReturns(all, 2026);
    const out = mixReturns(
      [
        { symbol: "TSP-C", share: 0.5 },
        { symbol: "TSP-L2050", share: 0.5 },
      ],
      returns,
    );
    expect(out.years.map((y) => y.year)).toEqual([2011, 2012]);
    // 2011: C +20%, L 2050 borrows L 2040's +10%: 15%.
    expect(out.years[0]!.rate).toBeCloseTo(0.15, 6);
    // 2012: C flat, L 2050 +5%: 2.5%.
    expect(out.years[1]!.rate).toBeCloseTo(0.025, 6);
    expect(out.standIns).toEqual([{ symbol: "TSP-L2050", by: "TSP-L2040", years: [2011] }]);
  });
});
