// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../test/fakeBackend";
import type { Account } from "../types/api";
import type { CardBill } from "../types/planning";
import { combinedTotals } from "../components/accounts/CombinedStatements";
import { CardStatementsPage, chosenCard, statementTotals } from "./CardStatementsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (id: number, name: string, over: Partial<Account> = {}): Account =>
  ({ id, name, type: "credit", hidden: false, currency: "USD", color: null, ...over }) as Account;

const bill = (accountId: number, remainingMinor: number, dueOn: string, status = "due"): CardBill =>
  ({
    accountId,
    settings: { closingDay: 5, dueDay: 28, minimumMinor: null, autopay: false },
    statement: {
      closedOn: "2026-10-05",
      dueOn,
      balanceMinor: 50000,
      paidMinor: 50000 - remainingMinor,
      remainingMinor,
      minimumMinor: null,
      status,
      daysUntilDue: 3,
    },
    next: { closesOn: "2026-11-05", dueOn: "2026-11-28", balanceSoFarMinor: 1200 },
    statementDays: null,
  }) as CardBill;

const statements = (closingDay: number | null) => ({
  accountId: 1,
  closingDay,
  dueDay: null,
  periods: [],
});

describe("statements across cards", () => {
  it("adds up what is left to pay and finds the soonest due date", () => {
    expect(
      statementTotals([
        bill(1, 1000, "2026-11-20"),
        bill(2, 500, "2026-11-10", "overdue"),
        bill(3, 0, "2026-11-01", "paid"),
      ]),
    ).toEqual({ remainingMinor: 1500, nextDue: "2026-11-10", overdue: 1 });
  });

  it("copes with a card that has no statement yet", () => {
    expect(statementTotals([{ ...bill(1, 0, "x"), statement: null }])).toEqual({
      remainingMinor: 0,
      nextDue: null,
      overdue: 0,
    });
  });

  it("shows the card asked for, or else the first", () => {
    const cards = [card(1, "A"), card(2, "B")];
    expect(chosenCard(cards, "2")?.name).toBe("B");
    expect(chosenCard(cards, "99")?.name).toBe("A");
    expect(chosenCard([], "1")).toBeNull();
  });
});

describe("the page", () => {
  const show = () =>
    render(
      <MemoryRouter>
        <CardStatementsPage />
      </MemoryRouter>,
    );

  it("lists only visible credit cards, and opens one's statements below", async () => {
    const calls = fakeBackend({
      "/accounts": [
        card(1, "Blue card"),
        card(2, "Red card"),
        card(3, "Old card", { hidden: true }),
        { ...card(4, "Checking"), type: "depository" },
      ],
      "/bills": [
        bill(1, 12345, "2026-11-20"),
        { ...bill(2, 0, "x"), settings: null, statement: null, next: null },
      ],
      "/accounts/1/statements?count=2": statements(5),
      "/accounts/2/statements?count=2": statements(null),
      "/accounts/1/statements?count=12": statements(5),
      "/accounts/2/statements?count=12": statements(null),
    });
    show();
    await screen.findByRole("button", { name: "Blue card" });
    expect(screen.queryByText("Old card")).toBeNull();
    expect(screen.queryByText("Checking")).toBeNull();
    await screen.findByText(/\$123\.45 left to pay on closed statements/);
    await userEvent.click(screen.getByRole("button", { name: "Red card" }));
    await screen.findByRole("heading", { name: "Red card" });
    await screen.findByText(/Set the day the statement closes/);
    expect(calls.some((c) => c.path === "/accounts/2/statements?count=12")).toBe(true);
  });

  it("picks a card from anywhere on its row, not just its name", async () => {
    fakeBackend({
      "/accounts": [card(1, "Blue card"), card(2, "Red card")],
      "/bills": [bill(1, 12345, "2026-11-20"), bill(2, 6789, "2026-11-22")],
      "/accounts/1/statements?count=2": statements(5),
      "/accounts/2/statements?count=2": statements(5),
      "/accounts/1/statements?count=12": statements(5),
      "/accounts/2/statements?count=12": statements(5),
    });
    show();
    await screen.findByRole("heading", { name: "Blue card" });
    await userEvent.click(await screen.findByText("$67.89"));
    await screen.findByRole("heading", { name: "Red card" });
    expect(screen.getByRole("button", { name: "Red card" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows a statement whose days were set on the card, not in Card bills", async () => {
    const closed = {
      end: "2026-10-05",
      due: "2026-10-28",
      chargesMinor: 7000,
      newBalanceMinor: 45600,
    };
    const open = {
      end: "2026-11-05",
      due: "2026-11-28",
      chargesMinor: 1200,
      newBalanceMinor: 7800,
    };
    fakeBackend({
      "/accounts": [card(1, "Blue card")],
      "/bills": [{ ...bill(1, 0, "x"), settings: null, statement: null, next: null }],
      "/accounts/1/statements?count=2": { ...statements(5), periods: [open, closed] },
      "/accounts/1/statements?count=12": statements(5),
    });
    show();
    await screen.findByText("$456.00");
    screen.getByText("$78.00");
    screen.getByText("Not tracked");
    screen.getByRole("link", { name: "Count this bill in the forecast" });
    // Nothing to pay can only be claimed about cards whose payments are tracked.
    expect(screen.queryByText(/Nothing left to pay/)).toBeNull();
    expect(screen.queryByText(/Set the closing day/)).toBeNull();
  });

  it("opens on all cards together when several have statements, and from there on one", async () => {
    const inMonth = (accountId: number, end: string, chargesMinor: number, current = false) => ({
      accountId,
      start: "2026-09-06",
      end,
      due: "2026-10-28",
      current,
      chargesMinor,
      paymentsMinor: 0,
      creditsMinor: 0,
      newBalanceMinor: chargesMinor,
      count: 1,
    });
    const month = (name: string, open: boolean, cards: ReturnType<typeof inMonth>[]) => ({
      month: name,
      open,
      chargesMinor: cards.reduce((n, c) => n + c.chargesMinor, 0),
      paymentsMinor: 0,
      creditsMinor: 0,
      newBalanceMinor: cards.reduce((n, c) => n + c.chargesMinor, 0),
      count: cards.length,
      cards,
      categories: [{ id: 1, name: "Food", color: null, spendingMinor: 4200 }],
      merchants: [{ name: "Grocer", spendingMinor: 4200, count: 2 }],
    });
    const combined = {
      cards: [
        { accountId: 1, name: "Blue card", color: null, currency: "USD" },
        { accountId: 2, name: "Red card", color: null, currency: "USD" },
      ],
      withoutClosingDay: [],
      months: [
        month("2026-11", true, [
          inMonth(1, "2026-11-05", 1100, true),
          inMonth(2, "2026-11-25", 900, true),
        ]),
        month("2026-10", false, [inMonth(1, "2026-10-05", 3000), inMonth(2, "2026-10-25", 1234)]),
      ],
    };
    expect(combinedTotals(combined)).toEqual({ closedMinor: 4234, openMinor: 2000 });
    const calls = fakeBackend({
      "/accounts": [
        card(1, "Blue card", { statementClosingDay: 5 }),
        card(2, "Red card", { statementClosingDay: 25 }),
      ],
      "/bills": [bill(1, 12345, "2026-11-20"), bill(2, 6789, "2026-11-22")],
      "/accounts/1/statements?count=2": statements(5),
      "/accounts/2/statements?count=2": statements(25),
      "/accounts/1/statements?count=12": statements(5),
      "/accounts/2/statements?count=12": statements(25),
      "/statements/combined?count=12": combined,
    });
    show();
    await screen.findByRole("heading", { name: "All cards together" });
    // The newest month whose statements have all closed is the one shown.
    await screen.findByRole("heading", { name: /Statements closing in October 2026/ });
    screen.getByText("Spending by category, all cards");
    expect(screen.getAllByText("$42.34").length).toBeGreaterThan(0);
    // A card's row in the month opens that card's statements.
    const open = screen.getAllByRole("button", { name: "Red card" }).at(-1)!;
    await userEvent.click(open);
    await screen.findByRole("heading", { name: "Red card" });
    expect(calls.some((c) => c.path === "/accounts/2/statements?count=12")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "All cards together" }));
    await screen.findByRole("heading", { name: "All cards together" });
  });

  it("says what to do with no cards", async () => {
    fakeBackend({ "/accounts": [], "/bills": [] });
    show();
    await screen.findByText(/No credit cards yet/);
    screen.getByRole("link", { name: "Add one under Accounts" });
  });
});
