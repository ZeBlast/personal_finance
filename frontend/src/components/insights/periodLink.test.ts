import { describe, expect, it } from "vitest";
import { measureLabel } from "../../lib/categoryTrends";
import { categoryListLabel } from "../../pages/TransactionsPage";
import { periodLink } from "./CategoryExplorer";

const base = { from: "2026-09-01", to: "2026-09-30", accounts: [] };

describe("opening a period of the category chart", () => {
  it("keeps every category on show, not only when there is one", () => {
    expect(
      periodLink({
        ...base,
        shown: [
          { categoryId: 3, direction: "out" },
          { categoryId: 7, direction: "in" },
          { categoryId: null, direction: "out" },
        ],
        everything: false,
      }),
    ).toBe("/transactions?from=2026-09-01&to=2026-09-30&category=3%2C7%2Cnone");
  });

  it("keeps the way the money went when every line on show goes the same way", () => {
    expect(
      periodLink({
        ...base,
        shown: [
          { categoryId: 3, direction: "in" },
          { categoryId: 7, direction: "in" },
        ],
        everything: false,
      }),
    ).toBe("/transactions?from=2026-09-01&to=2026-09-30&category=3%2C7&direction=in");
    // A category's money in and out both on show: both ways, one category.
    expect(
      periodLink({
        ...base,
        shown: [
          { categoryId: 3, direction: "in" },
          { categoryId: 3, direction: "out" },
        ],
        everything: false,
      }),
    ).toBe("/transactions?from=2026-09-01&to=2026-09-30&category=3");
  });

  it("leaves categories out when every line is on show, and keeps one account", () => {
    expect(
      periodLink({
        ...base,
        accounts: [12],
        shown: [{ categoryId: 3, direction: "in" }],
        everything: true,
      }),
    ).toBe("/transactions?from=2026-09-01&to=2026-09-30&account=12");
  });
});

describe("labels", () => {
  it("names several categories briefly", () => {
    const options = [
      { id: 3, name: "Food" },
      { id: 7, name: "Fun" },
      { id: 9, name: "Gas" },
    ];
    expect(categoryListLabel("3,7", options)).toBe("Food and Fun");
    expect(categoryListLabel("3,7,9,none", options)).toBe("Food, Fun and 2 more");
  });

  it("names the measures for every transaction", () => {
    expect(measureLabel("spending", "all")).toBe("Amount");
    expect(measureLabel("share", "all")).toBe("Share of all money moved");
    expect(measureLabel("spending", "out")).toBe("Amount spent");
  });
});
