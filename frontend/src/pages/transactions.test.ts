import { describe, expect, it } from "vitest";
import type { Transaction } from "../types/api";
import { categoryToRestore, transferToRestore, undoGroups } from "./TransactionsPage";

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

describe("undoing a bulk change", () => {
  it("puts back the user's own transfer answer, or lets the app decide again", () => {
    expect(transferToRestore({ isTransfer: true, transferSource: "manual" })).toBe(true);
    expect(transferToRestore({ isTransfer: false, transferSource: "manual" })).toBe(false);
    expect(transferToRestore({ isTransfer: true, transferSource: "auto" })).toBeNull();
    expect(transferToRestore({ isTransfer: false, transferSource: null })).toBeNull();
  });

  it("sends one request per value to put back", () => {
    const rows = [
      { id: 1, category: category("manual", 7) },
      { id: 2, category: category("rule", 3) },
      { id: 3, category: category("manual", 7) },
      { id: 4, category: null },
    ] as unknown as Transaction[];
    expect(undoGroups(rows, categoryToRestore)).toEqual([
      { value: 7, ids: [1, 3] },
      { value: null, ids: [2, 4] },
    ]);
  });
});
