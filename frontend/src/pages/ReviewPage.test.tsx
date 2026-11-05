// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../components/common/ConfirmHost";
import { fakeBackend } from "../test/fakeBackend";
import type { Transaction } from "../types/api";
import type { RefundReviewItem } from "../types/planning";
import { ReviewPage } from "./ReviewPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tx = (over: Partial<Transaction>): Transaction =>
  ({
    id: 1,
    accountName: "Visa",
    institutionName: null,
    date: "2026-09-10",
    authorizedDate: null,
    name: "",
    merchant: "",
    amountMinor: 0,
    currency: "USD",
    pending: false,
    isTransfer: false,
    category: null,
    refundOf: null,
    refundedMinor: 0,
    ...over,
  }) as Transaction;

const purchase = tx({ id: 9, date: "2026-09-01", merchant: "Shop A", amountMinor: 10_000 });

const item = (over: Partial<RefundReviewItem> = {}): RefundReviewItem => ({
  credit: tx({ id: 2, merchant: "Shop A", amountMinor: -3_000 }),
  suggestion: {
    transaction: purchase,
    confidence: "high",
    partial: true,
    generic: false,
    namesAgree: true,
    exactAmount: false,
    daysBefore: 9,
    leftMinor: 10_000,
  },
  needsCheck: false,
  ...over,
});

const quiet = {
  "/review": { items: [], windowDays: 30 },
  "/duplicates": [],
  "/review/uncategorized": { items: [], total: 0 },
  "/categories": [],
};

describe("possible refunds on the Review page", () => {
  it("shows the match, says what is left, and links it", async () => {
    const calls = fakeBackend({
      ...quiet,
      "/review/refunds": [item()],
      "PUT /transactions/2/refund-of": {},
    });
    render(<ReviewPage />);
    await screen.findByText("Possible refunds (1)");
    const row = screen.getByText("Likely match").closest("li")!;
    expect(row.textContent).toContain("Partial: $30.00 of $100.00 left");
    expect(row.textContent).toContain("Same merchant, different amount");
    await userEvent.click(within(row).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")).toMatchObject({
        path: "/transactions/2/refund-of",
        body: { originalId: 9 },
      }),
    );
  });

  it("asks differently before linking a weak match than a likely payout", async () => {
    const weak = item({ needsCheck: true });
    weak.suggestion.confidence = "low";
    fakeBackend({ ...quiet, "/review/refunds": [weak] });
    render(
      <>
        <ReviewPage />
        <ConfirmHost />
      </>,
    );
    await screen.findByText("Check first");
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByText("This is a weak match — check it's the same purchase.");
  });

  it("asks before linking a credit that may be a payout", async () => {
    const payout = item({ needsCheck: true });
    payout.suggestion.generic = true;
    const calls = fakeBackend({
      ...quiet,
      "/review/refunds": [payout],
      "PUT /transactions/2/refund-of": {},
    });
    render(
      <>
        <ReviewPage />
        <ConfirmHost />
      </>,
    );
    await screen.findByText("Check first");
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByText(/looks like a bank credit or payout/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Link anyway" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  });

  it("says so when there are none", async () => {
    fakeBackend({ ...quiet, "/review/refunds": [] });
    render(<ReviewPage />);
    await screen.findByText("No possible refunds");
  });
});
