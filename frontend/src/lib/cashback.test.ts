import { describe, expect, it } from "vitest";
import {
  buildRulesPayload,
  cashbackBadge,
  draftsFromRules,
  emptyDraft,
  formatRate,
  isBlankDraft,
  parseRatePercent,
  type CashbackRule,
  type RateDraft,
} from "./cashback";

describe("cashback rate text", () => {
  it("reads percentages with up to two decimals, with or without a percent sign", () => {
    expect(parseRatePercent("5")).toBe(5);
    expect(parseRatePercent("1.5")).toBe(1.5);
    expect(parseRatePercent(" 2.25% ")).toBe(2.25);
    expect(parseRatePercent("100")).toBe(100);
    expect(parseRatePercent("0")).toBe(0);
  });

  it("rejects what is not a clean percentage", () => {
    for (const bad of ["", "abc", "-1", "101", "1.234", "1,5", "5 %%", ".5"]) {
      expect(parseRatePercent(bad), bad).toBeNull();
    }
  });

  it("writes a rate the way people say it", () => {
    expect(formatRate(500)).toBe("5%");
    expect(formatRate(150)).toBe("1.5%");
    expect(formatRate(125)).toBe("1.25%");
    expect(formatRate(null)).toBe("no rate");
  });
});

describe("the rules editor", () => {
  const draft = (over: Partial<RateDraft>): RateDraft => ({ ...emptyDraft(), ...over });

  it("round-trips category rates, merchant rates, and exclusions", () => {
    const rules: CashbackRule[] = [
      {
        categoryId: 4,
        categoryName: "Groceries",
        merchant: null,
        exclude: false,
        ratePercent: 3,
        onlineOnly: false,
      },
      {
        categoryId: null,
        categoryName: null,
        merchant: null,
        exclude: false,
        ratePercent: 1.5,
        onlineOnly: true,
      },
      {
        categoryId: null,
        categoryName: null,
        merchant: "Costco",
        exclude: false,
        ratePercent: 2,
        onlineOnly: false,
      },
      {
        categoryId: 4,
        categoryName: "Groceries",
        merchant: "walmart",
        exclude: true,
        ratePercent: 0,
        onlineOnly: false,
      },
    ];
    const drafts = draftsFromRules(rules);
    expect(drafts.map((d) => d.kind)).toEqual(["category", "category", "merchant", "exclude"]);
    expect(drafts[3]).toMatchObject({ categoryId: "4", merchant: "walmart", rate: "" });
    const built = buildRulesPayload(drafts);
    expect(built).toEqual({
      ok: true,
      rules: rules.map(({ categoryId, merchant, exclude, ratePercent, onlineOnly }) => ({
        categoryId,
        merchant,
        exclude,
        ratePercent,
        onlineOnly,
      })),
    });
  });

  it("explains what is wrong", () => {
    const msg = (rows: RateDraft[]) => {
      const r = buildRulesPayload(rows);
      return r.ok ? "" : r.message;
    };
    expect(msg([draft({ rate: "x" })])).toMatch(/percentage/);
    expect(msg([draft({ kind: "exclude" })])).toMatch(/merchant/);
    expect(msg([draft({ kind: "merchant", merchant: "  ", rate: "2" })])).toMatch(/merchant/);
    expect(
      msg([draft({ categoryId: "4", rate: "3" }), draft({ categoryId: "4", rate: "2" })]),
    ).toMatch(/only one rate/);
    expect(
      msg([
        draft({ kind: "exclude", merchant: "Walmart" }),
        draft({ kind: "exclude", merchant: "walmart" }),
      ]),
    ).toMatch(/excluded twice/);
    // An ordinary and an online rate for the same category are two different rates.
    expect(
      buildRulesPayload([
        draft({ categoryId: "4", rate: "2" }),
        draft({ categoryId: "4", rate: "3", onlineOnly: true }),
      ]).ok,
    ).toBe(true);
  });

  it("treats an untouched row as blank, and allows no rules at all", () => {
    expect(isBlankDraft(emptyDraft())).toBe(true);
    expect(isBlankDraft(draft({ kind: "exclude" }))).toBe(false);
    expect(buildRulesPayload([])).toEqual({ ok: true, rules: [] });
  });
});

describe("the transaction badge", () => {
  const base = {
    cashbackMinor: 0,
    rateBps: 0,
    bestRateBps: 300,
    bestCard: "Grocery Card",
    online: false,
  };
  it("is green for the best card, yellow for another card, red for no credit card", () => {
    expect(cashbackBadge({ ...base, status: "best", rateBps: 300 }).tone).toBe("green");
    const yellow = cashbackBadge({ ...base, status: "card", rateBps: 100 });
    expect(yellow.tone).toBe("yellow");
    expect(yellow.title).toMatch(/Grocery Card would earn 3%/);
    expect(cashbackBadge({ ...base, status: "missed" })).toMatchObject({
      tone: "red",
      text: "no cashback",
    });
  });
});
