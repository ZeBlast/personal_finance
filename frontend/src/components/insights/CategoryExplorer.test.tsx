// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rangeFor } from "../../lib/categoryTrends";
import { fakeBackend } from "../../test/fakeBackend";
import { axisFor, CategoryExplorer } from "./CategoryExplorer";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const trends = {
  from: "2026-01-01",
  to: "2026-04-30",
  interval: "month",
  buckets: ["Jan", "Feb", "Mar", "Apr"].map((label, i) => ({
    key: String(i),
    label,
    from: "",
    to: "",
  })),
  series: [
    {
      key: "1",
      categoryId: 1,
      parentId: null,
      label: "Food & Drink",
      color: "#f59e0b",
      values: [0, 0, 500, 700],
      counts: [0, 0, 2, 3],
      previousTotal: 0,
      previousCount: 0,
    },
  ],
  allSpending: [0, 0, 500, 700],
  previous: { from: "", to: "" },
};

const categories = [
  {
    id: 1,
    name: "Food & Drink",
    parentId: null,
    color: null,
    active: true,
    incomeTreatment: null,
    transactionCount: 0,
    ruleCount: 0,
  },
  {
    id: 2,
    name: "Dining Out",
    parentId: 1,
    color: null,
    active: true,
    incomeTreatment: null,
    transactionCount: 0,
    ruleCount: 0,
  },
];

function trendsPath(flow: "out" | "all"): string {
  const { from, to } = rangeFor("12m");
  return `/analytics/category-trends?from=${from}&to=${to}&interval=month&categories=&accounts=&split=0&pending=1&flow=${flow}`;
}

function setup() {
  return fakeBackend({
    "GET /categories": categories,
    "GET /accounts": [],
    [trendsPath("out")]: trends,
    [trendsPath("all")]: trends,
  });
}

function renderExplorer() {
  return render(
    <MemoryRouter>
      <CategoryExplorer />
    </MemoryRouter>,
  );
}

describe("spending explorer defaults", () => {
  it("asks for spending only and starts at the first month with data", async () => {
    const calls = setup();
    renderExplorer();
    await screen.findByText("Parent category");
    const trendCall = calls.find((c) => c.path.startsWith("/analytics/category-trends"))!;
    expect(new URLSearchParams(trendCall.path.split("?")[1]).get("flow")).toBe("out");
    // Mar and Apr only: the empty Jan and Feb are left off the chart axis.
    const axis = screen.getByRole("img").textContent ?? "";
    expect(axis).toContain("Mar");
    expect(axis).not.toContain("Jan");
  });

  it("keeps the extra switches behind a closed Chart options disclosure", async () => {
    setup();
    renderExplorer();
    await screen.findByText("Parent category");
    const details = screen.getByText("Chart options").closest("details")!;
    expect(details.open).toBe(false);
    for (const label of ["Running total", "Average line", "Include pending"]) {
      expect(details.contains(screen.getByLabelText(label))).toBe(true);
    }
  });

  it("lists the subcategories in a parent line's tooltip", async () => {
    setup();
    renderExplorer();
    await waitFor(() =>
      expect(screen.getAllByTitle(/Includes Dining Out/).length).toBeGreaterThan(0),
    );
  });

  it("still honours a saved preference for money coming in", async () => {
    localStorage.setItem("pf.categoryExplorer.v1", JSON.stringify({ income: true }));
    const calls = setup();
    renderExplorer();
    await waitFor(() => expect(calls.some((c) => c.path.includes("flow=all"))).toBe(true));
  });
});

describe("axisFor", () => {
  it("reads money in cents: $5,000 is $5k, $450 is $450", () => {
    const money = axisFor("spending");
    expect(money(500_000)).toBe("$5k");
    expect(money(123_000)).toBe("$1.2k");
    expect(money(45_000)).toBe("$450");
    expect(money(0)).toBe("$0");
  });

  it("labels counts and shares plainly", () => {
    expect(axisFor("count")(3)).toBe("3");
    expect(axisFor("share")(40)).toBe("40%");
  });
});
