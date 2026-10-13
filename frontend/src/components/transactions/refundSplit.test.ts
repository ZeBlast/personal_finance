import { describe, expect, it } from "vitest";
import type { RefundAllocation } from "../../types/api";
import { buildRefundSplit } from "./RefundSplitDialog";

const allocation: RefundAllocation = {
  refundId: 2,
  originalId: 1,
  refundMinor: 8000,
  chosen: false,
  lines: [
    {
      categoryId: 10,
      categoryName: "Fun",
      spentMinor: 12000,
      refundedElsewhereMinor: 0,
      leftMinor: 12000,
      thisMinor: 0,
    },
    {
      categoryId: 11,
      categoryName: "Meals",
      spentMinor: 5000,
      refundedElsewhereMinor: 2000,
      leftMinor: 3000,
      thisMinor: 0,
    },
  ],
};

describe("dividing a refund across a purchase's categories", () => {
  it("gives money back to each category with an amount, leaving blank ones out", () => {
    expect(buildRefundSplit(allocation, ["50.00", "30.00"], "USD")).toEqual({
      ok: true,
      parts: [
        { categoryId: 10, amountMinor: -5000 },
        { categoryId: 11, amountMinor: -3000 },
      ],
    });
    expect(buildRefundSplit(allocation, ["80", ""], "USD")).toEqual({
      ok: true,
      parts: [{ categoryId: 10, amountMinor: -8000 }],
    });
  });

  it("says what is wrong: over what is left, or not adding up", () => {
    expect(buildRefundSplit(allocation, ["40", "40"], "USD")).toEqual({
      ok: false,
      message: "Meals has $30.00 left to give back.",
    });
    expect(buildRefundSplit(allocation, ["40", "10"], "USD")).toMatchObject({ ok: false });
    expect(buildRefundSplit(allocation, ["abc", "10"], "USD")).toMatchObject({ ok: false });
  });
});
