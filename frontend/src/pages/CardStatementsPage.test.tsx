// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../test/fakeBackend";
import type { Account } from "../types/api";
import type { CardBill } from "../types/planning";
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
    screen.getByRole("link", { name: "Track in Planning" });
    // Nothing to pay can only be claimed about cards whose payments are tracked.
    expect(screen.queryByText(/Nothing left to pay/)).toBeNull();
    expect(screen.queryByText(/Set the closing day/)).toBeNull();
  });

  it("says what to do with no cards", async () => {
    fakeBackend({ "/accounts": [], "/bills": [] });
    show();
    await screen.findByText(/No credit cards yet/);
    screen.getByRole("link", { name: "Add one under Accounts" });
  });
});
