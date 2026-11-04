// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMinor } from "../lib/money";
import { monthOf, today } from "../lib/period";
import { fakeBackend } from "../test/fakeBackend";
import type { Budget } from "../types/analytics";
import ThisMonth, { worstCap } from "./ThisMonthWidget";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const money = (n: number) => `$${(n / 100).toFixed(2)}`;
const cap = (over: Partial<Budget>): Budget =>
  ({
    categoryId: 1,
    categoryName: "Dining out",
    status: "ok",
    percentUsed: 10,
    remainingMinor: 9000,
    ...over,
  }) as Budget;

describe("the cap closest to its limit", () => {
  it("says nothing without caps", () => {
    expect(worstCap([], money)).toBeNull();
  });

  it("names a cap that is over, and by how much", () => {
    const r = worstCap(
      [cap({}), cap({ categoryName: "Groceries", status: "over", remainingMinor: -1250 })],
      money,
    );
    expect(r).toEqual({ text: "Groceries: Over by $12.50", bad: true });
  });

  it("prefers a cap at risk to one that is fine, and reads a fine one as on track", () => {
    expect(worstCap([cap({}), cap({ categoryName: "Fun", status: "risk" })], money)?.text).toBe(
      "Fun: At risk",
    );
    expect(worstCap([cap({})], money)).toEqual({ text: "Dining out: On track", bad: false });
  });
});

describe("the widget", () => {
  const show = () =>
    render(
      <MemoryRouter>
        <ThisMonth.Component config={{}} instanceId={1} size={{ w: 12, h: 2 }} />
      </MemoryRouter>,
    );
  const capsPath = `/budgets?month=${monthOf(today())}&today=${today()}`;

  it("shows the caps total, the tightest cap and the next income", async () => {
    fakeBackend({
      "/settings": { currency: "USD" },
      [capsPath]: {
        month: monthOf(today()),
        budgets: [cap({ categoryName: "Groceries", status: "over", remainingMinor: -500 })],
        totals: { budgetedMinor: 155000, spentMinor: 23590, remainingMinor: 131410 },
        unbudgetedSpendingMinor: 0,
      },
      "/brief?bufferMinor=0": {
        currency: "USD",
        nextIncome: { date: "2026-11-14", label: "Payroll", amountMinor: 200000 },
      },
    });
    show();
    await screen.findByText("$235.90");
    screen.getByText(/of \$1,550\.00 in caps/);
    screen.getByText("Groceries: Over by $5.00");
    await screen.findByText(/Next income: Payroll, \$2,000\.00 on/);
  });

  it("still shows the caps when the next income is not known", async () => {
    fakeBackend({
      "/settings": { currency: "USD" },
      [capsPath]: {
        month: monthOf(today()),
        budgets: [cap({})],
        totals: { budgetedMinor: 10000, spentMinor: 1000, remainingMinor: 9000 },
        unbudgetedSpendingMinor: 0,
      },
    });
    show();
    await screen.findByText("Dining out: On track");
    expect(screen.queryByText(/Next income/)).toBeNull();
  });

  it("formats in the user's currency and never shows dollars first", async () => {
    fakeBackend({
      "/settings": { currency: "EUR" },
      [capsPath]: {
        month: monthOf(today()),
        budgets: [cap({})],
        totals: { budgetedMinor: 155000, spentMinor: 23590, remainingMinor: 131410 },
        unbudgetedSpendingMinor: 0,
      },
    });
    show();
    expect(await screen.findByText(formatMinor(23_590, "EUR"), { exact: false })).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("offers to set a cap when there are none", async () => {
    fakeBackend({
      "/settings": { currency: "USD" },
      [capsPath]: {
        month: monthOf(today()),
        budgets: [],
        totals: { budgetedMinor: 0, spentMinor: 0, remainingMinor: 0 },
        unbudgetedSpendingMinor: 0,
      },
      "/brief?bufferMinor=0": { currency: "USD", nextIncome: null },
    });
    show();
    const link = await screen.findByRole("link", { name: "Set a cap" });
    expect(link.getAttribute("href")).toBe("/planning/budgets");
  });

  it("says when the caps cannot be loaded", async () => {
    fakeBackend({});
    show();
    await screen.findByRole("alert");
  });
});
