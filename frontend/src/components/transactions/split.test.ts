import { describe, expect, it } from "vitest";
import { buildSplit } from "./SplitDialog";

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
