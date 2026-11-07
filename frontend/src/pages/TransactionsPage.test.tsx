// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDay } from "../lib/time";
import { fakeBackend } from "../test/fakeBackend";
import type { Transaction } from "../types/api";
import { TransactionsPage } from "./TransactionsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A window `width` pixels wide, as far as media queries go. */
function windowWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width: ([\d.]+)px/.exec(query);
    const max = /max-width: ([\d.]+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

const purchase = {
  id: 1,
  accountId: 2,
  accountName: "Everyday Checking",
  accountColor: null,
  institutionName: null,
  date: "2026-11-06",
  authorizedDate: "2026-11-04",
  name: "Corner Grocer",
  merchant: "Corner Grocer",
  merchantOriginal: "Corner Grocer",
  amountMinor: 4_250,
  currency: "USD",
  pending: false,
  category: null,
  recipient: null,
  sender: null,
  source: "plaid",
  isTransfer: false,
  transferSource: null,
  mirror: null,
  beforeOtherHistory: false,
  refundOf: null,
  refundedMinor: 0,
  splits: [],
  splitValid: true,
  tags: [],
  online: false,
  onlineEdited: false,
  providerOnline: false,
  notes: null,
} as unknown as Transaction;

function show() {
  fakeBackend({
    "/categories": [],
    "/accounts": [],
    "/transactions?page=1&pageSize=50&sort=txdate_desc": {
      items: [purchase],
      total: 1,
      page: 1,
      pageSize: 50,
    },
  });
  render(
    <MemoryRouter>
      <TransactionsPage />
    </MemoryRouter>,
  );
}

const headers = () =>
  screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/g, "").trim());

describe("the transactions table", () => {
  it("keeps the amount in view on a narrow window, with the account under the merchant", async () => {
    windowWidth(900);
    show();
    const row = (await screen.findByText("Corner Grocer")).closest("tr")!;
    expect(headers()).toEqual(["", "Transaction date", "Merchant", "Category", "Amount"]);
    expect(
      within(row).getByText(`Everyday Checking · posted ${formatDay("2026-11-06")}`),
    ).toBeTruthy();
    expect(row.lastElementChild!.className).toContain("sticky");
  });

  it("shows every column on a wide window", async () => {
    windowWidth(1300);
    show();
    await screen.findByText("Corner Grocer");
    expect(headers()).toEqual([
      "",
      "Transaction date",
      "Posted",
      "Merchant",
      "Category",
      "Tags",
      "Online",
      "Account",
      "Recipient / sender",
      "Amount",
    ]);
    expect(screen.queryByText(/Everyday Checking · /)).toBeNull();
  });
});
