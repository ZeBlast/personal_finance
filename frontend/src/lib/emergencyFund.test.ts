import { describe, expect, it } from "vitest";
import { emergencyFundTargetMinor } from "./emergencyFund";

describe("the emergency fund target", () => {
  it("is three months of the median month, rounded up to the next $100", () => {
    // Median of 200000, 250000, 900000 is 250000; three months is 750000.
    expect(emergencyFundTargetMinor([900_000, 200_000, 250_000])).toBe(750_000);
    // Median 123456 * 3 = 370368, up to 380000.
    expect(emergencyFundTargetMinor([123_456])).toBe(380_000);
  });

  it("averages the middle two when the count is even", () => {
    expect(emergencyFundTargetMinor([100_000, 200_000, 300_000, 400_000])).toBe(750_000);
  });

  it("ignores months with no spending, and gives nothing when there is no month left", () => {
    expect(emergencyFundTargetMinor([0, 0, 200_000])).toBe(600_000);
    expect(emergencyFundTargetMinor([0, 0])).toBeNull();
    expect(emergencyFundTargetMinor([])).toBeNull();
  });
});
