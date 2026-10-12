import { describe, expect, it } from "vitest";
import type { Category } from "../types/api";
import { categoryOptions } from "./useCategories";

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
    // The dropdown draws the hierarchy from the depth; the label is the plain name.
    expect(options.find((o) => o.name === "Transportation")).toMatchObject({
      label: "Transportation",
      sub: false,
      depth: 0,
    });
    expect(options.find((o) => o.name === "Gas")).toMatchObject({
      label: "Gas",
      sub: true,
      depth: 1,
    });
  });
});
