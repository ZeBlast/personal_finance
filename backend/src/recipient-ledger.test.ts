import { describe, expect, it } from "vitest";
import { ledgerDelta, pageLedger, type LedgerAccount } from "./plaid/fake-ledger.js";
import { extractRecipient } from "./services/recipient.js";

const input = (
  name: string,
  amount: number,
  paymentPayee: string | null = null,
  paymentPayer: string | null = null,
) => ({ name, amount, paymentPayee, paymentPayer });

describe("recipient extraction", () => {
  it("reads the person from Zelle descriptions", () => {
    expect(extractRecipient(input("Zelle payment to Jane Doe", 25))).toEqual({
      recipient: "Jane Doe",
      source: "parsed",
    });
    expect(extractRecipient(input("ZELLE PAYMENT FROM ALEX SMITH", -40))).toEqual({
      recipient: "ALEX SMITH",
      source: "parsed",
    });
    expect(extractRecipient(input("Zelle to Maria Garcia", 10))?.recipient).toBe("Maria Garcia");
    expect(extractRecipient(input("Zelle from Maria Garcia", -10))?.recipient).toBe("Maria Garcia");
  });

  it("drops trailing reference numbers and confirmation codes", () => {
    expect(extractRecipient(input("Zelle payment to Jane Doe 4821", 25))?.recipient).toBe(
      "Jane Doe",
    );
    expect(extractRecipient(input("Zelle payment from Alex Smith 90211", -25))?.recipient).toBe(
      "Alex Smith",
    );
    expect(extractRecipient(input("Zelle payment to Jane Doe Conf# ab12cd", 25))?.recipient).toBe(
      "Jane Doe",
    );
    expect(extractRecipient(input("Zelle payment to Jane Doe ref 123", 25))?.recipient).toBe(
      "Jane Doe",
    );
    expect(extractRecipient(input("Zelle payment to Jane Doe,", 25))?.recipient).toBe("Jane Doe");
  });

  it("prefers the provider's payment metadata, by direction", () => {
    expect(extractRecipient(input("BILL PAY ONLINE", 50, "Sam Lee", null))).toEqual({
      recipient: "Sam Lee",
      source: "plaid",
    });
    // Money coming in uses the payer, not the payee.
    expect(extractRecipient(input("INCOMING", -50, "Someone Else", "Pat Kim"))?.recipient).toBe(
      "Pat Kim",
    );
    expect(extractRecipient(input("INCOMING", -50, "Someone Else", null))).toBeNull();
    // Metadata wins over a parseable description.
    expect(extractRecipient(input("Zelle payment to Jane Doe", 5, "Jane Q. Doe", null))).toEqual({
      recipient: "Jane Q. Doe",
      source: "plaid",
    });
  });

  it("finds nothing when there is no person to find", () => {
    expect(extractRecipient(input("WHOLEFDS MKT 10234", 55))).toBeNull();
    expect(extractRecipient(input("Zelle", 5))).toBeNull();
    expect(extractRecipient(input("NETFLIX.COM", 15.49))).toBeNull();
    expect(extractRecipient(input("Zelle payment to X", 5))).toBeNull(); // one character is not a name
  });

  it("caps very long names", () => {
    const long = "A".repeat(300);
    expect(extractRecipient(input(`Zelle payment to ${long}`, 5))?.recipient).toHaveLength(100);
  });
});

describe("demo ledger", () => {
  const accounts: LedgerAccount[] = [0, 1, 2].map((index) => ({
    accountId: `acct~${index}`,
    index,
  }));
  const bank = "ins_fake_bank";

  const drain = (cursor: string | null, today: string, pageSize = 25) => {
    const added: ReturnType<typeof pageLedger>["added"] = [];
    let page;
    let next = cursor;
    do {
      page = pageLedger(bank, accounts, next, today, pageSize);
      added.push(...page.added);
      next = page.nextCursor;
    } while (page.hasMore);
    return { added, last: page, cursor: next };
  };

  it("is deterministic", () => {
    const a = pageLedger(bank, accounts, null, "2026-09-01", 1000);
    const b = pageLedger(bank, accounts, null, "2026-09-01", 1000);
    expect(a).toEqual(b);
  });

  it("returns about 90 days of history in several pages on the first sync", () => {
    const { added, last } = drain(null, "2026-09-01", 25);
    expect(added.length).toBeGreaterThan(60);
    expect(last.nextCursor).toBe("fake~2026-09-01");
    const ids = new Set(added.map((t) => t.transactionId));
    expect(ids.size).toBe(added.length); // no duplicate IDs
    const dates = added.map((t) => t.date).sort();
    expect(dates[0]! >= "2026-06-04").toBe(true);
    expect(dates.at(-1)).toBe("2026-09-01");
  });

  it("marks only the last two days as pending", () => {
    const { added } = drain(null, "2026-09-01");
    for (const t of added) {
      expect(t.pending).toBe(t.date >= "2026-08-31");
      if (t.pending) expect(t.transactionId.startsWith("ptxn-fake~")).toBe(true);
    }
    expect(added.some((t) => t.pending)).toBe(true);
  });

  it("returns nothing when asked again on the same day", () => {
    const delta = ledgerDelta(bank, accounts, "2026-09-01", "2026-09-01");
    expect(delta).toEqual({ added: [], modified: [], removedIds: [] });
    const page = pageLedger(bank, accounts, "fake~2026-09-01", "2026-09-01", 25);
    expect(page.added).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe("fake~2026-09-01");
  });

  it("replaces each pending transaction with a posted one that points back at it", () => {
    const first = drain(null, "2026-09-01");
    const pendingIds = new Set(first.added.filter((t) => t.pending).map((t) => t.transactionId));
    expect(pendingIds.size).toBeGreaterThan(0);

    const later = ledgerDelta(bank, accounts, "2026-09-01", "2026-09-06");
    for (const id of later.removedIds) expect(pendingIds.has(id)).toBe(true);
    for (const id of pendingIds) expect(later.removedIds).toContain(id); // all of them posted
    const posted = later.added.filter((t) => t.pendingTransactionId !== null);
    expect(posted.map((t) => t.pendingTransactionId).sort()).toEqual([...later.removedIds].sort());
    for (const t of posted) expect(t.pending).toBe(false);
  });

  it("catches up on a long gap in one go", () => {
    const delta = ledgerDelta(bank, accounts, "2026-09-01", "2026-10-15");
    const dates = delta.added.map((t) => t.date);
    expect(dates.some((d) => d > "2026-10-10")).toBe(true);
    expect(dates.every((d) => d > "2026-08-30")).toBe(true);
  });

  it("enriches merchants a week later, as modified transactions", () => {
    let found = 0;
    for (let day = 1; day <= 28; day++) {
      const last = `2026-09-${String(day).padStart(2, "0")}`;
      const next = `2026-09-${String(day + 1).padStart(2, "0")}`;
      const delta = ledgerDelta(bank, accounts, last, next);
      for (const t of delta.modified) {
        expect(t.merchantName).not.toBeNull();
        expect(t.pending).toBe(false);
        found += 1;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("rejects a cursor it did not issue", () => {
    expect(() => pageLedger(bank, accounts, "garbage", "2026-09-01", 25)).toThrow();
  });

  it("never rewinds if the clock moves backwards", () => {
    const page = pageLedger(bank, accounts, "fake~2026-09-10", "2026-09-01", 25);
    expect(page.added).toHaveLength(0);
    expect(page.nextCursor).toBe("fake~2026-09-10");
  });

  it("includes the cases the recipient feature needs", () => {
    const { added } = drain(null, "2026-09-01", 1000);
    const names = added.map((t) => t.name);
    expect(names.some((n) => /^Zelle payment to /.test(n))).toBe(true);
    expect(names.some((n) => /^Zelle payment from /.test(n))).toBe(true);
    expect(added.some((t) => t.paymentPayee === "Sam Lee")).toBe(true);
    expect(added.some((t) => t.amount < 0)).toBe(true); // income / refunds
    expect(added.some((t) => t.amount > 0)).toBe(true);
  });
});
