// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import type { Category, Transaction } from "../../types/api";
import { resetToasts, subscribeToasts } from "../../lib/toast";
import { TransactionDetail } from "./TransactionDetail";

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tx = {
  id: 1,
  accountName: "Visa",
  date: "2026-10-02",
  authorizedDate: null,
  name: "CORNER COFFEE",
  merchant: "Corner Coffee",
  providerMerchant: "Corner Coffee",
  merchantEdited: false,
  amountMinor: 450,
  currency: "USD",
  pending: false,
  isTransfer: false,
  category: null,
  splits: [],
  tags: [],
  details: {
    datetime: null,
    authorizedDatetime: null,
    originalDescription: null,
    location: null,
    merchant: null,
    categoryConfidence: null,
    payment: null,
    counterparties: [],
  },
} as unknown as Transaction;

const categories = [
  { id: 5, name: "Dining", parentId: null, active: true, color: null },
] as unknown as Category[];

describe("making a rule from a transaction", () => {
  it("saves it for past transactions in one request and offers Undo", async () => {
    const calls = fakeBackend({
      "POST /rules/preview": { matchCount: 3 },
      "PATCH /transactions/1": tx,
      "POST /rules": { id: 8, name: "Corner Coffee → Dining", batchId: 12, changeCount: 3 },
      "/transactions/1": tx,
    });
    const seen: string[] = [];
    const unsubscribe = subscribeToasts((all) => {
      for (const t of all) if (t.action?.label === "Undo") seen.push(t.text);
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <TransactionDetail
        transaction={tx}
        categories={categories}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: /Category/ }));
    await user.click(screen.getByRole("option", { name: /Dining/ }));
    await user.click(screen.getByRole("checkbox", { name: /Always categorize/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST" && c.path === "/rules");
    expect(post?.body).toMatchObject({ scope: "all", matchValue: "Corner Coffee", categoryId: 5 });
    // The separate "apply everything" request is gone.
    expect(calls.some((c) => c.path === "/rules/apply")).toBe(false);
    expect(seen).toContain("Moved 3 transactions.");
    unsubscribe();
    resetToasts();
  });
});
