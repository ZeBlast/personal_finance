import { describe, expect, it } from "vitest";
import { transferLabel } from "./transferLabel";

const other = (
  accountName: string,
  accountType: string,
  institutionName: string | null = null,
) => ({
  id: 2,
  accountName,
  institutionName,
  accountType,
  date: "2026-10-08",
  transactionDate: "2026-10-08",
  merchant: "x",
});

describe("the other side of a transfer, in words", () => {
  it("names the account that paid a card, and the card a payment went to", () => {
    expect(
      transferLabel({
        accountType: "credit",
        amountMinor: -25000,
        transferWith: other("Checking", "depository", "Chase"),
      }),
    ).toBe("Paid from Checking (Chase)");
    expect(
      transferLabel({
        accountType: "depository",
        amountMinor: 25000,
        transferWith: other("Visa", "credit"),
      }),
    ).toBe("Paid Visa");
    expect(
      transferLabel({
        accountType: "depository",
        amountMinor: -500,
        transferWith: other("Savings", "depository"),
      }),
    ).toBe("Moved from Savings");
    expect(
      transferLabel({ accountType: "credit", amountMinor: -1, transferWith: null }),
    ).toBeNull();
  });
});
