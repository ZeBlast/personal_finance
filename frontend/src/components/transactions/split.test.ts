import { describe, expect, it } from "vitest";
import { amountsFromPercents, buildSplit, splitEvenly } from "./SplitDialog";

describe("dividing a transaction's cost", () => {
  it("splits evenly to the cent, the first parts taking the odd cents", () => {
    expect(splitEvenly(10_000, 3)).toEqual([3_334, 3_333, 3_333]);
    expect(splitEvenly(1, 3)).toEqual([1, 0, 0]);
    expect(splitEvenly(9_000, 2)).toEqual([4_500, 4_500]);
    for (const [total, n] of [
      [12_345, 7],
      [99, 4],
      [1_000_001, 3],
    ] as const) {
      expect(splitEvenly(total, n).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("turns percentages into amounts that add up exactly when they total 100", () => {
    expect(amountsFromPercents(10_000, [50, 30, 20])).toEqual([5_000, 3_000, 2_000]);
    // Thirds of $100: the cent left over goes where rounding lost the most.
    const thirds = amountsFromPercents(10_000, [33.34, 33.33, 33.33]);
    expect(thirds.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(amountsFromPercents(1_999, [70, 30]).reduce((a, b) => a + b, 0)).toBe(1_999);
    // Not yet 100: each part is just its share; a blank counts as nothing.
    expect(amountsFromPercents(10_000, [25, NaN])).toEqual([2_500, 0]);
  });
});

const part = (amount: string, categoryId = "") => ({ categoryId, amount, note: "" });

describe("building a split", () => {
  it("gives each part the transaction's sign, and needs the parts to add up", () => {
    expect(buildSplit([part("60", "1"), part("40.00", "2")], 10_000)).toEqual({
      ok: true,
      parts: [
        { categoryId: 1, amountMinor: 6_000, note: null },
        { categoryId: 2, amountMinor: 4_000, note: null },
      ],
    });
    // Money in (a negative amount in the bank's convention) splits into negative parts.
    expect(buildSplit([part("30"), part("20")], -5_000)).toMatchObject({
      ok: true,
      parts: [{ amountMinor: -3_000 }, { amountMinor: -2_000 }],
    });
  });

  it("says what is wrong", () => {
    const msg = (r: ReturnType<typeof buildSplit>) => (r.ok ? "" : r.message);
    expect(msg(buildSplit([part("100")], 10_000))).toMatch(/at least two/);
    expect(msg(buildSplit([part("60"), part("")], 10_000))).toMatch(/part 2/);
    expect(msg(buildSplit([part("60"), part("30")], 10_000))).toBe(
      "$10.00 is not in any part yet.",
    );
    expect(msg(buildSplit([part("60"), part("50")], 10_000))).toBe(
      "The parts add up to $10.00 more than the transaction.",
    );
  });
});
