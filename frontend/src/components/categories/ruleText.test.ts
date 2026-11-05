import { describe, expect, it } from "vitest";
import { batchUndoText, ruleTotalsText } from "./ruleText";

describe("ruleTotalsText", () => {
  it("names each category with its change to spending and how many transactions", () => {
    expect(
      ruleTotalsText(
        [
          { categoryId: 2, name: "Dining", changeMinor: 1_500, count: 3 },
          { categoryId: 1, name: "Treats", changeMinor: -1_500, count: 3 },
        ],
        "USD",
      ),
    ).toBe("Dining +$15.00 (3) · Treats −$15.00 (3)");
    expect(
      ruleTotalsText([{ categoryId: null, name: null, changeMinor: -500, count: 1 }], "USD"),
    ).toBe("Uncategorized −$5.00 (1)");
  });
});

describe("batchUndoText", () => {
  it("says what was put back and what keeps a newer category", () => {
    expect(batchUndoText({ restored: 2, kept: [{}] })).toBe(
      "Put back 2 transactions. 1 you changed since keeps its new category.",
    );
    expect(batchUndoText({ restored: 3, kept: [] })).toBe("Put back 3 transactions.");
    expect(
      batchUndoText({ restored: 0, kept: [{ reason: "its earlier category was deleted" }, {}] }),
    ).toBe(
      "Put back 0 transactions. 1 you changed since keeps its new category. 1 keeps its new category because the earlier one was deleted.",
    );
  });
});
