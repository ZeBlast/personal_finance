import { describe, expect, it } from "vitest";
import { goalAccountText } from "./GoalsPage";

const account = {
  id: 1,
  name: "Savings",
  balanceMinor: 500_000,
  countedMinor: 500_000,
  setMinor: null,
  short: false,
  sharedWith: [],
};

describe("what a goal owns of an account", () => {
  it("is the whole balance when no other goal uses it", () => {
    expect(goalAccountText(account)).toBe("Savings: $5,000.00");
  });
  it("shows the share and who else uses the account", () => {
    expect(
      goalAccountText({
        ...account,
        countedMinor: 150_000,
        setMinor: 150_000,
        sharedWith: ["Car"],
      }),
    ).toBe("Savings: $1,500.00 of $5,000.00 (set amount; shared with Car)");
    expect(
      goalAccountText({
        ...account,
        countedMinor: 0,
        setMinor: 10_000,
        short: true,
        sharedWith: ["Car"],
      }),
    ).toBe("Savings: $0.00 of $5,000.00 ($100.00 set, not enough left; shared with Car)");
  });
});
