import { describe, expect, it } from "vitest";
import type { AffordAnswer, MonthPlan, SafetyNet } from "../types/planTools";
import { affordSentence, leftLine, runwayText } from "./planTools";
import { formatDay } from "./time";

describe("leftLine", () => {
  const money = (n: number) => `$${n / 100}`;
  const plan = (leftMinor: number): MonthPlan => ({
    currency: "USD",
    month: "2026-10",
    today: "2026-10-09",
    lines: [{ kind: "income", label: "Pay", amountMinor: 100 }],
    totals: { income: 100, bill: 0, cap: 0, usual: 0, goal: 0, debt: 0 },
    leftMinor,
    actual: null,
  });
  it("says every dollar has a job at zero", () => {
    expect(leftLine(plan(0), money)).toEqual({ text: "Every dollar has a job.", tone: "good" });
  });
  it("says how much is not yet planned", () => {
    expect(leftLine(plan(12_000), money)).toEqual({ text: "$120 not yet planned.", tone: "good" });
  });
  it("says how short the plan is", () => {
    expect(leftLine(plan(-5_000), money)).toEqual({
      text: "$50 short: the plan asks for more than comes in.",
      tone: "short",
    });
  });
  it("says so when there is nothing to plan yet", () => {
    expect(leftLine({ ...plan(0), lines: [] }, money)).toEqual({
      text: "Nothing expected this month yet.",
      tone: "good",
    });
  });
});

describe("affordSentence", () => {
  const money = (n: number) => `$${n / 100}`;
  const base: AffordAnswer = {
    currency: "USD",
    today: "2026-10-09",
    amountMinor: 40_000,
    bufferMinor: 0,
    reservedMinor: 0,
    floorMinor: 0,
    horizonEnd: "2027-01-07",
    alreadyShort: false,
    asked: null,
    earliest: null,
    plans: [],
  };
  const low = { date: "2026-10-12", balanceMinor: 5_000 };

  it("says yes for the day asked, with the low point and the room left", () => {
    const s = affordSentence(
      {
        ...base,
        asked: { date: "2026-10-10", ok: true, lowest: low, marginMinor: 5_000 },
        earliest: { date: "2026-10-09", lowest: low },
      },
      money,
    );
    expect(s.ok).toBe(true);
    expect(s.headline).toBe(`Yes, on ${formatDay("2026-10-10")}.`);
    expect(s.detail).toBe(
      `Your cash is lowest on ${formatDay("2026-10-12")} at $50, $50 above what you keep.`,
    );
  });

  it("says when instead, when the day asked does not work", () => {
    const s = affordSentence(
      {
        ...base,
        asked: { date: "2026-10-10", ok: false, lowest: low, marginMinor: -100 },
        earliest: { date: "2026-10-20", lowest: low },
      },
      money,
    );
    expect(s.ok).toBe(false);
    expect(s.headline).toBe(
      `Not on ${formatDay("2026-10-10")}. The earliest is ${formatDay("2026-10-20")}.`,
    );
  });

  it("says today when no day was asked and today works", () => {
    const s = affordSentence({ ...base, earliest: { date: "2026-10-09", lowest: low } }, money);
    expect(s).toMatchObject({ ok: true, headline: "Yes, today." });
  });

  it("says not within the forecast, and warns when it already dips", () => {
    const s = affordSentence({ ...base, alreadyShort: true }, money);
    expect(s.ok).toBe(false);
    expect(s.headline).toBe("Not in the next 90 days.");
    expect(s.detail).toMatch(/already dips below/);
  });
});

const net = (over: Partial<SafetyNet>): SafetyNet => ({
  currency: "USD",
  cashMinor: 0,
  reservedMinor: 0,
  freeCashMinor: 0,
  monthlyMinor: 100_000,
  basis: "essential",
  monthsAveraged: 3,
  months: 0,
  essentials: [],
  ...over,
});

describe("runwayText", () => {
  it("is good at or above the target", () => {
    expect(runwayText(net({ months: 7 }), 6)).toMatchObject({ headline: "7 months", tone: "good" });
    expect(runwayText(net({ months: 1 }), 1).headline).toBe("1 month");
  });
  it("warns below the target", () => {
    expect(runwayText(net({ months: 2.5 }), 6)).toMatchObject({
      headline: "2.5 months",
      tone: "warn",
    });
  });
  it("says so when there is no spending yet", () => {
    expect(runwayText(net({ months: null, monthlyMinor: 0 }), 6)).toMatchObject({
      headline: "No spending yet",
      tone: "none",
    });
  });
  it("explains the figure, and nudges toward essentials when all spending counts", () => {
    const essential = runwayText(
      net({ months: 5, monthlyMinor: 100_000, freeCashMinor: 500_000 }),
      6,
    );
    expect(essential.detail).toBe("$1,000.00 a month of essentials, from $5,000.00 after goals.");
    const all = runwayText(net({ months: 5, basis: "all" }), 6);
    expect(all.detail).toMatch(/all spending/);
  });
});
