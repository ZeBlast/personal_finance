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

describe("tags for a purchase shown on PayPal and on what paid it", () => {
  it("says which account paid, without its institution, on the PayPal row", () => {
    expect(
      mirrorLabel({
        mirror: {
          role: "copy",
          source: "auto",
          with: other("Customized Cash Rewards Visa Signature", "Bank of America"),
        },
      }),
    ).toBe("Paid using Customized Cash Rewards Visa Signature");
  });

  it("says PayPal on the paying row, and nothing without a link", () => {
    expect(
      mirrorLabel({ mirror: { role: "counts", source: "auto", with: other("PayPal", "PayPal") } }),
    ).toBe("Paid via PayPal");
    expect(mirrorLabel({ mirror: null })).toBeNull();
  });
});
