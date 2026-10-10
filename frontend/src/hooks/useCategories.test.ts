import { describe, expect, it } from "vitest";
import type { Category } from "../types/api";
import { categoryOptions, MAIN_MARK, SUB_MARK } from "./useCategories";

const cat = (id: number, name: string, parentId: number | null = null): Category =>
  ({ id, name, parentId }) as Category;

describe("category picker options", () => {
  it("lists each main category, marked, followed by its subcategories, indented", () => {
    const options = categoryOptions([
      cat(1, "Transportation"),
      cat(2, "Gas", 1),
      cat(3, "Groceries"),
      cat(4, "Parking & Tolls", 1),
      cat(5, "Transfers"),
      cat(6, "Cash Withdrawals", 5),
      // A main category whose name starts like another's still sorts on its own.
      cat(7, "Transport"),
    ]);
    expect(options.map((o) => o.name)).toEqual([
      "Groceries",
      "Transfers",
      "Cash Withdrawals",
      "Transport",
      "Transportation",
      "Gas",
      "Parking & Tolls",
    ]);
    expect(options.find((o) => o.name === "Transportation")).toMatchObject({
      label: `${MAIN_MARK} Transportation`,
      sub: false,
    });
    expect(options.find((o) => o.name === "Gas")).toMatchObject({
      label: `${SUB_MARK}Gas`,
      sub: true,
    });
  });
});
