import { describe, expect, it } from "vitest";
import { cellDensity } from "./density";

describe("how much a calendar day box shows", () => {
  it("shows everything in roomy boxes, less as they shrink", () => {
    expect(cellDensity(7 * 150, 5 * 150, 5)).toBe("full");
    expect(cellDensity(7 * 100, 5 * 150, 5)).toBe("compact");
    expect(cellDensity(7 * 150, 6 * 100, 6)).toBe("compact");
    expect(cellDensity(7 * 50, 5 * 150, 5)).toBe("tiny");
    expect(cellDensity(7 * 150, 6 * 50, 6)).toBe("tiny");
  });

  it("shows everything before it has been measured", () => {
    expect(cellDensity(0, 0, 5)).toBe("full");
  });
});
