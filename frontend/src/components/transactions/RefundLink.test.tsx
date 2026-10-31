// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import type { Transaction } from "../../types/api";
import { candidatesPath, dayGap, RefundLink } from "./RefundLink";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Just what the refund link reads of a transaction. */
const tx = (over: Partial<Transaction>): Transaction =>
  ({
    id: 1,
    accountName: "Visa",
    date: "2026-10-02",
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

const refund = tx({ id: 2, merchant: "Outdoor Store", name: "OUTDOOR STORE", amountMinor: -5000 });
const charge = tx({
  id: 9,
  date: "2026-09-10",
  merchant: "Outdoor Store",
  name: "OUTDOOR STORE #12 SEATTLE",
  amountMinor: 5000,
  category: { id: 3, name: "Shopping" } as Transaction["category"],
});
const tent = tx({ id: 10, date: "2025-11-20", merchant: "Camping World", amountMinor: 12999 });

const suggestion = (t: Transaction, over: object = {}) => ({
  transaction: t,
  namesAgree: false,
  exactAmount: false,
  daysBefore: 22,
  leftMinor: t.amountMinor,
  ...over,
});

describe("finding what a refund gives back", () => {
  it("suggests, searches all history, shows more, and links the one picked", async () => {
    const calls = fakeBackend({
      [candidatesPath(2, "", false, 10)]: {
        suggestions: [suggestion(charge, { namesAgree: true, exactAmount: true })],
        more: true,
        range: "recent",
      },
      [candidatesPath(2, "", false, 20)]: {
        suggestions: [
          suggestion(charge, { namesAgree: true, exactAmount: true }),
          suggestion(tent),
        ],
        more: false,
        range: "recent",
      },
      [candidatesPath(2, "camping", false, 10)]: {
        suggestions: [suggestion(tent, { daysBefore: 316 })],
        more: false,
        range: "all",
      },
      "PUT /transactions/2/refund-of": { ...refund, refundOf: { id: 10 } },
    });
    const onChanged = vi.fn();
    render(<RefundLink transaction={refund} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "This is a refund of..." }));

    // The likeliest, with what tells it apart: its category and the bank's own description.
    const first = (await screen.findByText("Likely")).closest("li")!;
    expect(first.textContent).toContain("Shopping");
    expect(first.textContent).toContain("22 days before");
    expect(first.textContent).toContain("OUTDOOR STORE #12 SEATTLE");
    expect(screen.getByRole("button", { name: "Look further back than 6 months" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByText("Camping World");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search purchases" }), "camping");
    await screen.findByText("Searching all of your history.");
    await waitFor(() => expect(screen.queryByText("Outdoor Store")).toBeNull());
    expect(screen.getByText("Camping World").closest("li")!.textContent).toContain(
      "316 days before",
    );

    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      path: "/transactions/2/refund-of",
      body: { originalId: 10 },
    });
  });

  it("from a purchase: finds the money that came back and links it to this purchase", async () => {
    const calls = fakeBackend({
      [candidatesPath(9, "", false, 10)]: {
        suggestions: [suggestion(refund, { daysBefore: 22, leftMinor: null, exactAmount: true })],
        more: false,
        range: "recent",
      },
      "PUT /transactions/2/refund-of": { ...refund, refundOf: { id: 9 } },
      "/transactions/9": { ...charge, refundedMinor: 5000 },
    });
    const onChanged = vi.fn();
    render(<RefundLink transaction={charge} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "Link a refund..." }));
    const row = (await screen.findByText("22 days after", { exact: false })).closest("li")!;
    expect(row.textContent).toContain("$50.00");

    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    // The refund is linked to this purchase, and the purchase is shown again as it now is.
    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 9, refundedMinor: 5000 }),
      ),
    );
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ originalId: 9 });
  });

  it("lists a purchase's refunds, each of which can be unlinked", async () => {
    const calls = fakeBackend({
      "/transactions/9/refunds": [{ ...refund, refundOf: { id: 9, source: "auto" } }],
      "PUT /transactions/2/refund-of": refund,
      "/transactions/9": charge,
    });
    const onChanged = vi.fn();
    render(<RefundLink transaction={{ ...charge, refundedMinor: 5000 }} onChanged={onChanged} />);
    expect(await screen.findByText(/found by the app/)).toBeTruthy();
    // Fully refunded: nothing more to link.
    expect(screen.queryByRole("button", { name: "Link a refund..." })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(charge));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ originalId: null });
  });

  it("says how far apart they are from the side looked at", () => {
    expect(dayGap(22, true)).toBe("22 days before");
    expect(dayGap(-1, true)).toBe("1 day after");
    expect(dayGap(22, false)).toBe("22 days after");
    expect(dayGap(-2, false)).toBe("2 days before");
    expect(dayGap(0, false)).toBe("same day");
  });
});
