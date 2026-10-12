import { describe, expect, it } from "vitest";
import {
  allocationTotal,
  buildAllocations,
  buildContribution,
  draftFromContribution,
  emptyContributionDraft,
  employerAmount,
  estimateUnits,
  evenSplit,
  parsePercent,
  type TspContribution,
} from "./tsp";

describe("allocation percentages", () => {
  it("reads percentages with up to two decimals", () => {
    expect(parsePercent("60")).toBe(60);
    expect(parsePercent(" 12.5% ")).toBe(12.5);
    expect(parsePercent("33.33")).toBe(33.33);
    for (const bad of ["", "0", "-5", "101", "1.234", "x", "1,5"]) {
      expect(parsePercent(bad), bad).toBeNull();
    }
  });

  it("adds up without floating-point drift", () => {
    expect(
      allocationTotal([
        { symbol: "a", percent: "33.33" },
        { symbol: "b", percent: "33.33" },
        { symbol: "c", percent: "33.34" },
      ]),
    ).toBe(100);
    expect(allocationTotal([{ symbol: "a", percent: "oops" }])).toBe(0);
  });

  it("splits evenly to the hundredth, and the total is exactly 100", () => {
    for (const n of [1, 2, 3, 6, 7]) {
      const rows = evenSplit(Array.from({ length: n }, (_, i) => `F${i}`));
      expect(rows).toHaveLength(n);
      expect(allocationTotal(rows)).toBe(100);
    }
    expect(evenSplit(["a", "b", "c"]).map((r) => r.percent)).toEqual(["33.34", "33.33", "33.33"]);
    expect(evenSplit([])).toEqual([]);
  });

  it("builds the request only when the split is a valid 100%", () => {
    expect(
      buildAllocations([
        { symbol: "TSP-C", percent: "60" },
        { symbol: "TSP-S", percent: "40" },
      ]),
    ).toEqual({
      ok: true,
      allocations: [
        { symbol: "TSP-C", percent: 60 },
        { symbol: "TSP-S", percent: 40 },
      ],
    });
    const message = (rows: Array<{ symbol: string; percent: string }>) => {
      const r = buildAllocations(rows);
      return r.ok ? "" : r.message;
    };
    expect(message([])).toMatch(/at least one/);
    expect(message([{ symbol: "", percent: "100" }])).toMatch(/Choose a fund/);
    expect(message([{ symbol: "TSP-C", percent: "99" }])).toMatch(/99%/);
    expect(
      message([
        { symbol: "TSP-C", percent: "50" },
        { symbol: "TSP-C", percent: "50" },
      ]),
    ).toMatch(/only once/);
    expect(message([{ symbol: "TSP-C", percent: "x" }])).toMatch(/percentage/);
    // A blank spare row is ignored.
    expect(
      buildAllocations([
        { symbol: "TSP-C", percent: "100" },
        { symbol: "", percent: "" },
      ]).ok,
    ).toBe(true);
  });
});

describe("estimating units", () => {
  it("works out units from the amount, the share, and the price", () => {
    expect(estimateUnits(50000, 60, 110)).toBe(2.7273);
    expect(estimateUnits(50000, 100, 100)).toBe(5);
    expect(estimateUnits(50000, 60, null)).toBeNull();
    expect(estimateUnits(50000, 60, 0)).toBeNull();
  });
});

describe("the contribution form", () => {
  it("starts as a biweekly contribution from a date", () => {
    expect(emptyContributionDraft("2026-10-09")).toMatchObject({
      frequency: "biweekly",
      startDate: "2026-10-09",
    });
  });

  it("builds the request, with days of the month only where they apply", () => {
    const weekly = buildContribution({
      ...emptyContributionDraft("2026-10-05"),
      amount: "500",
      frequency: "weekly",
    });
    expect(weekly).toEqual({
      ok: true,
      payload: {
        amountMinor: 50000,
        frequency: "weekly",
        startDate: "2026-10-05",
        endDate: null,
        matchPlan: null,
      },
    });
    const twice = buildContribution({
      ...emptyContributionDraft("2026-10-01"),
      amount: "250.50",
      frequency: "semimonthly",
      dayOfMonth: "1",
      secondDay: "-1",
    });
    expect(twice).toMatchObject({
      ok: true,
      payload: {
        amountMinor: 25050,
        frequency: "semimonthly",
        dayOfMonth: 1,
        secondDayOfMonth: -1,
      },
    });
    const monthly = buildContribution({
      ...emptyContributionDraft("2026-10-15"),
      amount: "100",
      frequency: "monthly",
    });
    expect(monthly).toMatchObject({ ok: true, payload: { dayOfMonth: null } });
  });

  it("explains what is wrong", () => {
    const msg = (over: Record<string, string>) => {
      const r = buildContribution({
        ...emptyContributionDraft("2026-10-05"),
        amount: "500",
        ...over,
      });
      return r.ok ? "" : r.message;
    };
    expect(msg({ amount: "abc" })).toMatch(/amount/);
    expect(msg({ amount: "-5" })).toMatch(/amount/);
    expect(msg({ startDate: "" })).toMatch(/first date/);
    expect(msg({ endDate: "2026-01-01" })).toMatch(/before/);
    expect(msg({ frequency: "monthly", dayOfMonth: "40" })).toMatch(/day of the month/);
  });

  it("round-trips an existing contribution", () => {
    const c: TspContribution = {
      id: 1,
      amountMinor: 120000,
      frequency: "semimonthly",
      startDate: "2026-01-01",
      endDate: "2027-01-01",
      dayOfMonth: 1,
      secondDayOfMonth: 15,
      matchPlan: "fers",
      payMinor: 400000,
      matchPercent: null,
      matchUpToPercent: null,
      autoPercent: null,
      employerMinor: 0,
      active: true,
      description: "",
      nextDate: null,
    };
    const draft = draftFromContribution(c);
    expect(draft).toMatchObject({
      amount: "1200.00",
      dayOfMonth: "1",
      secondDay: "15",
      endDate: "2027-01-01",
    });
    expect(buildContribution(draft)).toMatchObject({
      ok: true,
      payload: {
        amountMinor: 120000,
        frequency: "semimonthly",
        dayOfMonth: 1,
        secondDayOfMonth: 15,
        endDate: "2027-01-01",
        matchPlan: "fers",
        payMinor: 400000,
      },
    });
  });
});

describe("employer match", () => {
  const m = (over: Partial<Parameters<typeof employerAmount>[0]>) =>
    employerAmount({
      amountMinor: 20000,
      matchPlan: "fers",
      payMinor: 400000,
      matchPercent: null,
      matchUpToPercent: null,
      autoPercent: null,
      ...over,
    });
  it("matches the backend's FERS and custom rules", () => {
    expect(m({})).toBe(20000); // 5% in: 1% automatic + 4% match
    expect(m({ amountMinor: 0 })).toBe(4000);
    expect(m({ matchPlan: "custom", matchPercent: 50, matchUpToPercent: 3, autoPercent: 0 })).toBe(
      10000,
    );
    expect(m({ matchPlan: null })).toBe(0);
  });

  it("needs the pay, and builds the custom fields", () => {
    const draft = { ...emptyContributionDraft("2026-10-05"), amount: "200" };
    expect(buildContribution({ ...draft, matchPlan: "fers" })).toEqual({
      ok: false,
      message: "Enter your gross pay for each contribution, such as 4000.00.",
    });
    expect(
      buildContribution({
        ...draft,
        matchPlan: "custom",
        pay: "4000",
        matchPercent: "50",
        matchUpTo: "6",
      }),
    ).toMatchObject({
      ok: true,
      payload: {
        matchPlan: "custom",
        payMinor: 400000,
        matchPercent: 50,
        matchUpToPercent: 6,
        autoPercent: 0,
      },
    });
  });
});

describe("downloading prices", () => {
  it("asks for a number of days, everything, or everything since a day", async () => {
    const { buildFetchRequest } = await import("./tsp");
    expect(buildFetchRequest("maxtsp", "90", "", "2026-10-09")).toEqual({
      ok: true,
      body: { source: "maxtsp", days: 90 },
    });
    expect(buildFetchRequest("tsp.gov", "since", "2021-06-15", "2026-10-09")).toEqual({
      ok: true,
      body: { source: "tsp.gov", since: "2021-06-15" },
    });
    expect(buildFetchRequest("maxtsp", "all", "", "2026-10-09")).toMatchObject({
      body: { since: "2003-01-01" },
    });
    for (const bad of ["", "2027-01-01"]) {
      expect(buildFetchRequest("maxtsp", "since", bad, "2026-10-09").ok, bad).toBe(false);
    }
    expect(buildFetchRequest("maxtsp", "missing", "", "2026-10-09")).toEqual({
      ok: true,
      body: { source: "maxtsp", missing: true },
    });
  });
});

describe("one-time contributions", () => {
  it("send just the amount and the day, with no schedule", () => {
    const draft = {
      ...emptyContributionDraft("2026-03-04", "once"),
      amount: "250",
      endDate: "2026-12-31",
    };
    expect(buildContribution(draft)).toEqual({
      ok: true,
      payload: {
        amountMinor: 25000,
        frequency: "once",
        startDate: "2026-03-04",
        endDate: null,
        matchPlan: null,
      },
    });
    expect(buildContribution({ ...draft, startDate: "" })).toEqual({
      ok: false,
      message: "Choose the date.",
    });
  });
});
