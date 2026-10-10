import { describe, expect, it } from "vitest";
import { accountLabel } from "./accountLabel";

describe("account labels", () => {
  it("adds the institution in parentheses, unless the name already says it or there is none", () => {
    expect(accountLabel("Customized Cash Rewards", "Bank of America")).toBe(
      "Customized Cash Rewards (Bank of America)",
    );
    expect(accountLabel("Cash", null)).toBe("Cash");
    expect(accountLabel("Chase Freedom", "Chase")).toBe("Chase Freedom");
  });
});
