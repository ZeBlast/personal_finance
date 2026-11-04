import { describe, expect, it } from "vitest";
import type { Category } from "../types/api";
import { childNames, rolledUpTitle } from "./categoryRollup";

const cat = (id: number, name: string, parentId: number | null, active = true): Category => ({
  id,
  name,
  parentId,
  color: null,
  active,
  incomeTreatment: null,
  transactionCount: 0,
  ruleCount: 0,
});

const list = [
  cat(1, "Food & Drink", null),
  cat(2, "Dining Out", 1),
  cat(3, "Groceries", 1),
  cat(4, "Takeout", 1, false),
  cat(5, "Transportation", null),
];

describe("category roll-up helpers", () => {
  it("lists every subcategory of a main category by name, marking archived ones", () => {
    expect(childNames(list, "Food & Drink")).toEqual([
      "Dining Out",
      "Groceries",
      "Takeout (archived)",
    ]);
  });

  it("gives nothing for a category without subcategories or an unknown name", () => {
    expect(childNames(list, "Transportation")).toEqual([]);
    expect(childNames(list, "Dining Out")).toEqual([]);
    expect(childNames(list, "Nope")).toEqual([]);
  });

  it("builds the tooltip text", () => {
    expect(rolledUpTitle("Food & Drink", ["Dining Out", "Groceries"])).toBe(
      "Food & Drink. Includes Dining Out, Groceries",
    );
    expect(rolledUpTitle("Transportation", [])).toBe("Transportation");
    expect(rolledUpTitle("Rent", [], "Click for its transactions.")).toBe(
      "Rent. Click for its transactions.",
    );
  });
});
