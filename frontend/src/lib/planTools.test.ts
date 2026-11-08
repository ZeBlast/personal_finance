import { describe, expect, it } from "vitest";
import type { AffordAnswer, SafetyNet } from "../types/planTools";
import { affordSentence, runwayText } from "./planTools";
import { formatDay } from "./time";

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
