// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import type { Account } from "../../types/api";
import { ReconcileDialog } from "./ReconcileDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const today = new Date().toISOString().slice(0, 10);
const account = { id: 4, name: "Checking", type: "depository", currency: "USD" } as Account;

describe("saving a statement check", () => {
  it("says why a check that agrees is not confirmed when the records stop short", async () => {
    const gaps = [{ from: "2026-10-21", to: today, reason: "not_synced" }];
    const calls = fakeBackend({
      [`/accounts/4/reconcile?date=${today}&statementMinor=100000`]: {
        accountId: 4,
        accountName: "Checking",
        type: "depository",
        statementDate: today,
        periodFrom: "2026-10-01",
        currentMinor: 100_000,
        sinceCount: 0,
        sinceMinor: 0,
        ledgerMinor: 100_000,
        statementMinor: 100_000,
        differenceMinor: 0,
        nearCutoff: [],
        pending: [],
        duplicates: [],
        gaps,
      },
      "/accounts/4/reconciliations": [],
      "POST /accounts/4/reconciliations": {
        id: 1,
        accountId: 4,
        statementDate: today,
        statementBalanceMinor: 100_000,
        appBalanceMinor: 100_000,
        differenceMinor: 0,
        status: "unresolved",
        note: null,
        createdAt: today,
        gaps,
      },
    });
    render(<ReconcileDialog account={account} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText(/Ending balance/), "1000");
    await userEvent.click(await screen.findByRole("button", { name: "Save this check" }));
    const message = await screen.findByText(/so this can't be confirmed yet/);
    expect(message.textContent).toMatch(/sync and check again/);
    expect(calls.some((c) => c.method === "POST")).toBe(true);
    expect(screen.queryByText(/Checked against a statement/)).toBeNull();
  });
});
