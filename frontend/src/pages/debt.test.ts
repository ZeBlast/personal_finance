import { describe, expect, it } from "vitest";
import { parseApr, payoffMonthLabel, payoffWhen } from "./DebtPage";

describe("debt payoff page", () => {
  it("reads a rate as a percent", () => {
    expect(parseApr("24.99")).toBe(2499);
    expect(parseApr(" 7% ")).toBe(700);
    expect(parseApr("0")).toBe(0);
    expect(parseApr("abc")).toBeNull();
    expect(parseApr("150")).toBeNull();
  });

  it("says when it is paid off", () => {
    expect(payoffWhen(17, "2026-10-18")).toBe("March 2028 (17 months)");
    expect(payoffWhen(1, "2026-10-18")).toBe("November 2026 (1 month)");
    expect(payoffWhen(null)).toMatch(/^never/);
  });

  it("labels where a chart line ends", () => {
    expect(payoffMonthLabel(35, "2026-10-18")).toBe("Sep 2029");
    expect(payoffMonthLabel(0, "2026-10-18")).toBe("Oct 2026");
    expect(payoffMonthLabel(null)).toBe("Not paid off");
  });
});
