// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMinor } from "../../../lib/money";
import { fakeBackend } from "../../../test/fakeBackend";
import type { Account, PlaidItem } from "../../../types/api";
import { AccountCardsView } from "./AccountCardsView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const usd = (minor: number) => formatMinor(minor, "USD");

function account(id: number, name: string, extra: Partial<Account>): Account {
  return {
    id,
    itemId: 1,
    institutionName: "First Platypus Bank",
    connectionStatus: "active",
    name,
    officialName: null,
    type: "depository",
    subtype: null,
    mask: null,
    currency: "USD",
    currentBalanceMinor: 0,
    availableBalanceMinor: null,
    lastBalanceUpdateAt: "2026-10-01T08:00:00.000Z",
    source: "plaid",
    isManual: false,
    hidden: false,
    countsInTotals: true,
    color: "#2563eb",
    creditLimitMinor: null,
    statementClosingDay: null,
    statementDueDay: null,
    // Still shared by Plaid (a field newer versions of the API send).
    noLongerSharedAt: null,
    ...extra,
  } as Account;
}

const item = {
  id: 1,
  institutionName: "First Platypus Bank",
  status: "active",
  lastSuccessfulSyncAt: null,
  logo: null,
  borrowed: false,
  accounts: [],
} as unknown as PlaidItem;

function show(accounts: Account[]) {
  fakeBackend({ "/accounts?includeHidden=1": accounts, "/categories": [] });
  render(
    <MemoryRouter>
      <AccountCardsView items={[item]} />
    </MemoryRouter>,
  );
}

const card = async (name: string) =>
  (await screen.findByRole("button", { name: new RegExp(`^${name}:`) })) as HTMLElement;

describe("the account cards", () => {
  it("shows a credit card's balance owed, the share of its limit used, and its due day", async () => {
    show([
      account(3, "Visa", {
        type: "credit",
        subtype: "credit card",
        mask: "3333",
        currentBalanceMinor: 41_000,
        availableBalanceMinor: 159_000,
        creditLimitMinor: 200_000,
        statementDueDay: 28,
      }),
    ]);
    const front = within(await card("Visa"));
    expect(front.getByText("Balance owed")).toBeTruthy();
    expect(front.getByText(usd(41_000))).toBeTruthy();
    expect(front.getByText(/21% used · due the 28th/)).toBeTruthy();
    expect(front.getByText(`Limit ${usd(200_000)}`)).toBeTruthy();
  });

  it("calls a card paid past zero a credit balance, shown as a positive amount", async () => {
    show([
      account(4, "Store card", {
        type: "credit",
        currentBalanceMinor: -4_000,
        creditLimitMinor: 50_000,
      }),
    ]);
    const front = within(await card("Store card"));
    expect(front.getByText("Credit balance")).toBeTruthy();
    expect(front.getByText(usd(4_000))).toBeTruthy();
  });

  it("says a loan's balance is owed, and a connection that needs a sign-in says so", async () => {
    show([
      account(5, "Car loan", { type: "loan", currentBalanceMinor: 1_452_000 }),
      account(6, "Checking", { connectionStatus: "login_required", currentBalanceMinor: 11_000 }),
    ]);
    expect(within(await card("Car loan")).getByText("Balance owed")).toBeTruthy();
    expect(within(await card("Checking")).getByText("Needs sign-in")).toBeTruthy();
  });

  it("turns over on a click to show the details and what can be done", async () => {
    show([
      account(3, "Visa", {
        type: "credit",
        currentBalanceMinor: 41_000,
        availableBalanceMinor: 159_000,
        creditLimitMinor: 200_000,
      }),
    ]);
    const visa = await card("Visa");
    expect(visa.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(visa);
    expect(visa.getAttribute("aria-pressed")).toBe("true");
    const back = within(visa);
    expect(back.getByText("Available credit")).toBeTruthy();
    expect(back.getByRole("button", { name: "Statements" })).toBeTruthy();
    expect(back.getByRole("button", { name: "Rate & payoff" })).toBeTruthy();
  });
});
