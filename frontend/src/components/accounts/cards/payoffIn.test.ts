import { describe, expect, it } from "vitest";
import { payoffIn } from "./AccountCardsView";

describe("how long a debt takes to pay off", () => {
  it("counts months up to two years, then years and months", () => {
    expect(payoffIn(1)).toBe("1 month");
    expect(payoffIn(14)).toBe("14 months");
    expect(payoffIn(24)).toBe("2 yr");
    expect(payoffIn(63)).toBe("5 yr 3 mo");
  });
});
