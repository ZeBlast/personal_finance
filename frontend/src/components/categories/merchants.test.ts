import { describe, expect, it } from "vitest";
import { merchantStatus } from "./MerchantsSection";

const assigned = { ruleId: 1, categoryId: 2, categoryName: "Dining" };

describe("merchantStatus", () => {
  it("says nothing about a merchant that is fully organized", () => {
    expect(
      merchantStatus({ assigned, uncategorizedCount: 0, categoryCount: 1, transactionCount: 9 }),
    ).toBeNull();
    // Categorized without an assignment, all in one category.
    expect(
      merchantStatus({
        assigned: null,
        uncategorizedCount: 0,
        categoryCount: 1,
        transactionCount: 9,
      }),
    ).toBeNull();
  });

  it("flags a merchant with no category at all", () => {
    expect(
      merchantStatus({
        assigned: null,
        uncategorizedCount: 4,
        categoryCount: 0,
        transactionCount: 4,
      }),
    ).toBe("no category yet");
  });

  it("describes mixed categories and partial coverage", () => {
    expect(
      merchantStatus({
        assigned: null,
        uncategorizedCount: 0,
        categoryCount: 3,
        transactionCount: 9,
      }),
    ).toBe("transactions are in different categories");
    expect(
      merchantStatus({
        assigned: null,
        uncategorizedCount: 2,
        categoryCount: 1,
        transactionCount: 9,
      }),
    ).toBe("2 without a category");
  });

  it("explains an assigned merchant whose transactions differ because you chose them", () => {
    expect(
      merchantStatus({ assigned, uncategorizedCount: 0, categoryCount: 2, transactionCount: 9 }),
    ).toMatch(/different category you chose/);
  });
});
