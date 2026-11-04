// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Transaction } from "../../types/api";
import { AccountCell, TransactionTags, TransferNote } from "./TransactionCells";

afterEach(cleanup);

const transfer = {
  isTransfer: true,
  mirror: null,
  accountType: "depository",
  amountMinor: -500,
  transferWith: {
    id: 2,
    accountName: "Plaid Checking",
    institutionName: "First Platypus Bank",
    accountType: "depository",
    date: "2026-10-08",
    transactionDate: "2026-10-08",
    merchant: "x",
  },
} as unknown as Transaction;

describe("transaction row cells", () => {
  it("shows the account name alone, with the institution in the tooltip", () => {
    const { container } = render(
      <AccountCell
        t={{
          accountName: "Plaid Checking",
          institutionName: "First Platypus Bank",
          accountColor: null,
        }}
      />,
    );
    expect(container.textContent).toBe("Plaid Checking");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      "Plaid Checking (First Platypus Bank)",
    );
  });

  it("shows a transfer as one muted line without the institution", () => {
    render(<TransferNote t={transfer} />);
    const note = screen.getByText("Moved from Plaid Checking");
    expect(note.className).toContain("truncate");
    expect(note.className).toContain("text-slate-500");
    expect(note.getAttribute("title")).toContain("Moved from Plaid Checking (First Platypus Bank)");
  });

  it("shows no transfer note for an ordinary purchase", () => {
    const { container } = render(<TransferNote t={{ ...transfer, isTransfer: false }} />);
    expect(container.textContent).toBe("");
  });

  it("no longer repeats Pending or the transfer as tags", () => {
    const { container } = render(
      <TransactionTags
        t={
          {
            ...transfer,
            pending: true,
            splits: [],
            refundedMinor: 0,
            refundOf: null,
            source: "plaid",
          } as unknown as Transaction
        }
      />,
    );
    expect(container.textContent).toBe("");
  });
});
