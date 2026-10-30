import { describe, expect, it } from "vitest";
import { categoryToRestore } from "./TransactionsPage";

const category = (source: "manual" | "rule", id: number) => ({
  id,
  name: "Groceries",
  color: null,
  active: true,
  source,
  ruleName: source === "rule" ? "Grocery stores" : null,
});

describe("undoing a quick category change", () => {
  it("puts back a category the user had chosen", () => {
    expect(categoryToRestore({ category: category("manual", 7) })).toBe(7);
  });

  it("hands one the rules had chosen back to the rules, so it stays automatic", () => {
    expect(categoryToRestore({ category: category("rule", 3) })).toBeNull();
  });

  it("leaves an uncategorized one uncategorized", () => {
    expect(categoryToRestore({ category: null })).toBeNull();
  });
});
