// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDay } from "../lib/time";
import { fakeBackend } from "../test/fakeBackend";
import type { Transaction } from "../types/api";
import { filterChips, TransactionsPage } from "./TransactionsPage";

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

describe("filterChips", () => {
  it("names each filter behind the Filter button, and leaves out search and account", () => {
    const none = {
      q: "coffee",
      accountId: "2",
      category: "",
      direction: "",
      pending: "",
      online: "",
      transfer: "",
      institution: "",
      from: "",
      to: "",
      dateBasis: "",
    };
    expect(filterChips(none, [])).toEqual([]);
    expect(
      filterChips(
        {
          ...none,
          institution: "manual",
          category: "3,none",
          direction: "out",
          pending: "false",
          online: "true",
          transfer: "unmatched",
          from: "2026-11-01",
          dateBasis: "posted",
        },
        [{ id: 3, name: "Food" }],
      ).map((c) => c.label),
    ).toEqual([
      "Kept by hand",
      "Food and Uncategorized",
      "Money out only",
      "Posted only",
      "Online only",
      "Transfers missing the other side",
      `From ${formatDay("2026-11-01")}`,
      "Dates by posted date",
    ]);
  });
});

describe("the filter bar", () => {
  const page = { items: [purchase], total: 1, page: 1, pageSize: 50 };

  it("keeps the less-used filters behind a Filter button", async () => {
    show();
    const user = userEvent.setup();
    await screen.findByText("Corner Grocer");
    expect(screen.getByRole("searchbox", { name: "Search transactions" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Account" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Money in or out" })).toBeNull();
    const toggle = screen.getByRole("button", { name: /^Filter/ });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Money in or out" })).toBeTruthy();
  });

  it("shows a filter from a link as a chip, and removing it lists everything again", async () => {
    const calls = fakeBackend({
      "/categories": [],
      "/accounts": [],
      "/transactions?page=1&pageSize=50&sort=txdate_desc": page,
      "/transactions?page=1&pageSize=50&sort=txdate_desc&direction=out": page,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/transactions?direction=out"]}>
        <TransactionsPage />
      </MemoryRouter>,
    );
    const chips = await screen.findByRole("list", { name: "Filters in use" });
    expect(within(chips).getByText("Money out only")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Filter/ }).textContent).toContain("1");
    await user.click(screen.getByRole("button", { name: "Remove filter: Money out only" }));
    await waitFor(() =>
      expect(calls.at(-1)?.path).toBe("/transactions?page=1&pageSize=50&sort=txdate_desc"),
    );
    expect(screen.queryByRole("list", { name: "Filters in use" })).toBeNull();
  });
});
