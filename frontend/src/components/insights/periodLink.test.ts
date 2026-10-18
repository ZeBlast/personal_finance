import { describe, expect, it } from "vitest";
import { measureLabel } from "../../lib/categoryTrends";
import { categoryListLabel } from "../../pages/TransactionsPage";
import { periodLink } from "./CategoryExplorer";

const base = { from: "2026-09-01", to: "2026-09-30", flow: "out" as const, accounts: [] };

describe("opening a period of the category chart", () => {
  it("keeps every category on show, not only when there is one", () => {
    expect(
      periodLink({
        ...base,
        shown: [{ categoryId: 3 }, { categoryId: 7 }, { categoryId: null }],
        everything: false,
      }),
    ).toBe("/transactions?from=2026-09-01&to=2026-09-30&category=3%2C7%2Cnone");
    expect(periodLink({ ...base, shown: [{ categoryId: 3 }], everything: false })).toBe(
      "/transactions?from=2026-09-01&to=2026-09-30&category=3",
    );
  });

  it("leaves categories out when all are on show, and keeps money in and one account", () => {
    expect(
      periodLink({
        ...base,
        flow: "in",
        accounts: [12],
        shown: [{ categoryId: 3 }, { categoryId: 7 }],
        everything: true,
      }),
    ).toBe("/transactions?from=2026-09-01&to=2026-09-30&direction=in&account=12");
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

  it("says money in when the chart shows money in", () => {
    expect(measureLabel("spending", "in")).toBe("Amount in");
    expect(measureLabel("share", "in")).toBe("Share of all money in");
    expect(measureLabel("spending", "out")).toBe("Amount spent");
  });
});
