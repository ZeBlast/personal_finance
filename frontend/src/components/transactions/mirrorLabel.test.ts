import { describe, expect, it } from "vitest";
import { mirrorLabel } from "./TransactionCells";

const other = (accountName: string, institutionName: string | null) => ({
  id: 2,
  accountName,
  institutionName,
  accountType: "credit",
  date: "2026-10-01",
  transactionDate: "2026-10-01",
  merchant: "Whatnot",
});

const visa = other("Customized Cash Rewards Visa Signature", "Bank of America");
const paypal = other("PayPal", "PayPal");

describe("tags for a purchase shown on PayPal and on what paid it", () => {
  it("says which account paid, without its institution, on the PayPal row", () => {
    expect(
      mirrorLabel({ amountMinor: 1999, mirror: { role: "copy", source: "auto", with: visa } }),
    ).toBe("Paid using Customized Cash Rewards Visa Signature");
  });

  it("says PayPal on the paying row, and nothing without a link", () => {
    expect(
      mirrorLabel({ amountMinor: 1999, mirror: { role: "counts", source: "auto", with: paypal } }),
    ).toBe("Paid via PayPal");
    expect(mirrorLabel({ amountMinor: 1999, mirror: null })).toBeNull();
  });

  it("says where a PayPal refund was paid out to, and that the card's credit came via PayPal", () => {
    expect(
      mirrorLabel({ amountMinor: -1999, mirror: { role: "copy", source: "auto", with: visa } }),
    ).toBe("Refunded to Customized Cash Rewards Visa Signature");
    expect(
      mirrorLabel({ amountMinor: -1999, mirror: { role: "counts", source: "auto", with: paypal } }),
    ).toBe("Refund via PayPal");
  });
});
