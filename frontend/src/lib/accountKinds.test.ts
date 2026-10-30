import { describe, expect, it } from "vitest";
import {
  availableCreditMinor,
  balanceDetail,
  balanceLabel,
  hasCreditBalance,
  shownBalanceMinor,
} from "./accountKinds";
import { formatMinor } from "./money";

const account = (
  type: string,
  currentBalanceMinor: number | null,
  extra: { availableBalanceMinor?: number | null; creditLimitMinor?: number | null } = {},
) => ({
  type,
  currency: "USD",
  currentBalanceMinor,
  availableBalanceMinor: extra.availableBalanceMinor ?? null,
  creditLimitMinor: extra.creditLimitMinor ?? null,
});
const usd = (minor: number) => formatMinor(minor, "USD");

describe("account kinds", () => {
  it("shows a card's available credit and how much of the limit is used", () => {
    const card = account("credit", 25_000, { creditLimitMinor: 100_000 });
    expect(availableCreditMinor(card)).toBe(75_000);
    expect(balanceLabel(card)).toBe("Balance owed");
    expect(balanceDetail(card)).toBe(`balance owed · 25% of ${usd(100_000)} used`);
    expect(balanceDetail(account("credit", 25_000))).toBe("balance owed");
  });

  it("never shows negative available credit on a card over its limit", () => {
    expect(availableCreditMinor(account("credit", 120_000, { creditLimitMinor: 100_000 }))).toBe(0);
  });

  it("calls a card paid past zero a credit balance, shown as a positive amount", () => {
    const card = account("credit", -4_000, { creditLimitMinor: 100_000 });
    expect(hasCreditBalance(card)).toBe(true);
    expect(shownBalanceMinor(card)).toBe(4_000);
    expect(balanceLabel(card)).toBe("Credit balance");
    expect(availableCreditMinor(card)).toBe(100_000);
  });

  it("says a loan's balance is owed and an investment's is its value", () => {
    expect(balanceLabel(account("loan", 1_500_000))).toBe("Balance owed");
    expect(balanceDetail(account("loan", 1_500_000))).toBe("balance owed");
    expect(balanceLabel(account("investment", 900_000))).toBe("Value");
    expect(balanceDetail(account("investment", 900_000))).toBe("market value");
  });

  it("shows what a bank account has available", () => {
    expect(balanceDetail(account("depository", 50_000, { availableBalanceMinor: 45_000 }))).toBe(
      `${usd(45_000)} available`,
    );
    expect(balanceDetail(account("depository", 50_000))).toBe("current balance");
    expect(shownBalanceMinor(account("depository", -1_000))).toBe(-1_000);
  });
});
