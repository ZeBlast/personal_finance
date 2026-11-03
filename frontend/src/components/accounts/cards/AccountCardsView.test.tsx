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

  describe("a bank account's interest", () => {
    const interest = (apyBps: number | null) => ({
      accountId: 4,
      apyBps,
      balanceMinor: 205_000,
      monthlyMinor: apyBps === null ? null : 73,
      yearlyMinor: apyBps === null ? null : 880,
      earnedThisYearMinor: 0,
      earnedLast12MonthsMinor: 0,
    });
    function showSavings(apyBps: number | null) {
      fakeBackend({
        "/accounts?includeHidden=1": [account(4, "Savings", { subtype: "savings" })],
        "/categories": [],
        "/accounts/4/interest": interest(apyBps),
      });
      render(
        <MemoryRouter>
          <AccountCardsView items={[item]} />
        </MemoryRouter>,
      );
    }

    it("shows the APY and the monthly interest on the back, and opens it from there", async () => {
      showSavings(425);
      const savings = await card("Savings");
      await userEvent.click(savings);
      await userEvent.click(
        await within(savings).findByRole("button", { name: `4.25% APY · ${usd(73)} a month` }),
      );
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog)
          .getByText(/Interest · 4.25% APY/)
          .closest("details")?.open,
      ).toBe(true);
    });

    it("offers Set APY when none is set, and More... leaves the interest folded", async () => {
      showSavings(null);
      const savings = await card("Savings");
      await userEvent.click(savings);
      await userEvent.click(await within(savings).findByRole("button", { name: "Set APY" }));
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog)
          .getByText(/Interest · set the APY/)
          .closest("details")?.open,
      ).toBe(true);
      await userEvent.click(within(dialog).getByRole("button", { name: /close/i }));
      await userEvent.click(within(savings).getByRole("button", { name: "More..." }));
      const again = await screen.findByRole("dialog");
      expect(
        within(again)
          .getByText(/Interest · set the APY/)
          .closest("details")?.open,
      ).toBe(false);
    });

    it("asks for the interest only when the card is turned over", async () => {
      const calls = fakeBackend({
        "/accounts?includeHidden=1": [account(4, "Savings", { subtype: "savings" })],
        "/categories": [],
        "/accounts/4/interest": interest(425),
      });
      render(
        <MemoryRouter>
          <AccountCardsView items={[item]} />
        </MemoryRouter>,
      );
      const savings = await card("Savings");
      expect(calls.some((c) => c.path.includes("/interest"))).toBe(false);
      await userEvent.click(savings);
      await within(savings).findByRole("button", { name: /APY/ });
      expect(calls.some((c) => c.path === "/accounts/4/interest")).toBe(true);
    });
  });
});
