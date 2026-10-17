import { describe, expect, it } from "vitest";
import { describeTspActivity } from "./tspActivity";

describe("the TSP activity import summary", () => {
  it("says what was recorded, what was already there and what was skipped", () => {
    expect(
      describeTspActivity({
        added: 54,
        alreadyThere: 0,
        skipped: 0,
        from: "2024-09-04",
        to: "2026-10-01",
        holdingsUpdated: true,
      }),
    ).toMatch(/^Recorded 54 contributions from .+ to .+\. The units were added to the holdings\.$/);
    expect(
      describeTspActivity({
        added: 1,
        alreadyThere: 3,
        skipped: 2,
        from: null,
        to: null,
        holdingsUpdated: false,
      }),
    ).toBe("Recorded 1 contribution. 3 were already there. 2 for unknown funds were skipped.");
  });
});
