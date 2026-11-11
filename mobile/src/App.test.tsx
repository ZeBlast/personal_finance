// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createSession } from "./lib/session";
import { fakeNative, makeFile } from "./test/fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const account = (over: Record<string, unknown>) => ({
  id: 1,
  itemId: 1,
  institutionName: "First Platypus Bank",
  connectionStatus: "active",
  name: "Everyday Checking",
  officialName: null,
  type: "depository",
  subtype: "checking",
  mask: "1234",
  currency: "USD",
  currentBalanceMinor: 250_000,
  availableBalanceMinor: 250_000,
  lastBalanceUpdateAt: null,
  source: "plaid",
  isManual: false,
  hidden: false,
  countsInTotals: true,
  color: null,
  creditLimitMinor: null,
  statementClosingDay: null,
  statementDueDay: null,
  noLongerSharedAt: null,
  lastReconciled: null,
  ...over,
});

const resources = {
  "/accounts": [
    account({}),
    account({
      id: 2,
      name: "Rewards Card",
      type: "credit",
      currentBalanceMinor: 12_345,
      creditLimitMinor: 500_000,
    }),
    account({ id: 3, name: "Old savings", hidden: true }),
  ],
  "/analytics/overview": {
    currency: "USD",
    cashMinor: 250_000,
    investmentsMinor: 0,
    otherAssetsMinor: 0,
    assetsMinor: 250_000,
    creditDebtMinor: 12_345,
    loanDebtMinor: 0,
    liabilitiesMinor: 12_345,
    netWorthMinor: 237_655,
    coverage: {},
    creditCards: [],
  },
  "/budgets?month=2026-11&today=2026-11-09": {
    month: "2026-11",
    budgets: [
      {
        id: 1,
        categoryName: "Groceries",
        spentMinor: 30_000,
        availableMinor: 40_000,
        percentUsed: 75,
        overspent: false,
      },
    ],
    totals: {},
    unbudgetedSpendingMinor: 0,
  },
  "/calendar/expected?from=2026-11-09&to=2027-01-08": [
    {
      id: "p1",
      date: "2026-11-12",
      merchant: "Rent",
      amountMinor: 150_000,
      direction: "out",
      status: "expected",
    },
    {
      id: "p2",
      date: "2026-12-20",
      merchant: "Far away",
      amountMinor: 1,
      direction: "out",
      status: "expected",
    },
  ],
  "/sync/status": {
    items: [
      {
        itemId: 1,
        institutionName: "Big Bank",
        connectionStatus: "login_required",
        lastSuccessfulSyncAt: null,
      },
    ],
  },
  "/transactions?from=2025-11-01&to=2026-11-09": {
    items: [
      {
        id: 10,
        accountId: 1,
        date: "2026-11-08",
        merchant: "Corner Grocer",
        amountMinor: 4_250,
        currency: "USD",
        pending: false,
        category: { name: "Groceries" },
      },
      {
        id: 11,
        accountId: 1,
        date: "2026-11-01",
        merchant: "Payroll",
        amountMinor: -300_000,
        currency: "USD",
        pending: false,
        category: null,
      },
      {
        id: 12,
        accountId: 2,
        date: "2026-11-02",
        merchant: "Card only",
        amountMinor: 100,
        currency: "USD",
        pending: false,
        category: null,
      },
    ],
    total: 3,
    page: 1,
    pageSize: 3,
  },
};

async function openApp() {
  const { native } = fakeNative({
    file: makeFile(resources, { createdAt: new Date().toISOString() }),
  });
  const session = createSession(native);
  await session.pair();
  await session.pick();
  render(<App session={createSession(native)} />);
  await userEvent.click(await screen.findByRole("button", { name: "Unlock" }));
}

describe("the viewer", () => {
  it("starts on pairing when nothing is paired", async () => {
    const { native } = fakeNative();
    render(<App session={createSession(native)} />);
    expect(await screen.findByRole("button", { name: "Pair with PC" })).toBeTruthy();
  });

  it("shows net worth, caps, the week ahead and sign-in problems", async () => {
    await openApp();
    expect(await screen.findByText("$2,376.55")).toBeTruthy();
    expect(screen.getByText("Groceries")).toBeTruthy();
    expect(screen.getByText("Rent")).toBeTruthy();
    expect(screen.queryByText("Far away")).toBeNull();
    expect(screen.getByText(/Sign in again on the PC: Big Bank/)).toBeTruthy();
  });

  it("lists accounts by group, hides hidden ones, and opens an account's activity", async () => {
    await openApp();
    await userEvent.click(await screen.findByRole("button", { name: "Accounts" }));
    expect(screen.getByText("Cash")).toBeTruthy();
    expect(screen.getByText("Credit cards")).toBeTruthy();
    expect(screen.queryByText("Old savings")).toBeNull();
    await userEvent.click(screen.getByText("Everyday Checking"));
    expect(screen.getByText("Corner Grocer")).toBeTruthy();
    expect(screen.getByText("+$3,000.00")).toBeTruthy();
    expect(screen.queryByText("Card only")).toBeNull();
  });
});
