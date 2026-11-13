import { describe, expect, it } from "vitest";
import type { Lookup } from "../types/places";
import {
  foundText,
  inTab,
  isApproximate,
  reviewSummary,
  tabCounts,
  tabOf,
  verdictText,
} from "./lookupReview";

const lookup = (over: Partial<Lookup>): Lookup => ({
  key: over.asked ?? "k",
  shop: null,
  asked: "100 Main St, Springfield, IL",
  found: "100, Main Street, Springfield",
  precision: "address",
  lat: 39.8,
  lon: -89.6,
  lookedUpAt: "2026-11-01T10:00:00.000Z",
  purchases: 1,
  verdict: null,
  canMove: true,
  ...over,
});

describe("checking looked-up positions", () => {
  it("sorts a lookup into to check, checked or found nothing", () => {
    expect(tabOf(lookup({}))).toBe("check");
    expect(tabOf(lookup({ verdict: "right" }))).toBe("checked");
    expect(tabOf(lookup({ verdict: "wrong" }))).toBe("checked");
    expect(tabOf(lookup({ lat: null, lon: null, found: null }))).toBe("nothing");
    // Found nothing, then placed by hand.
    expect(tabOf(lookup({ found: null, verdict: "moved" }))).toBe("checked");
  });

  it("puts approximate positions first, then those that place the most purchases", () => {
    const list = [
      lookup({ asked: "exact, few", purchases: 2 }),
      lookup({ asked: "exact, many", purchases: 9 }),
      lookup({ asked: "city", precision: "city", purchases: 1 }),
      lookup({ asked: "street", precision: "street", purchases: 4 }),
      lookup({ asked: "done", verdict: "right", purchases: 50 }),
    ];
    expect(inTab(list, "check").map((l) => l.asked)).toEqual([
      "street",
      "city",
      "exact, many",
      "exact, few",
    ]);
    expect(inTab(list, "checked").map((l) => l.asked)).toEqual(["done"]);
    expect(tabCounts(list)).toEqual({ check: 4, checked: 1, nothing: 0 });
  });

  it("does not call a position set by hand approximate", () => {
    expect(isApproximate(lookup({ precision: "postcode" }))).toBe(true);
    expect(isApproximate(lookup({ precision: "street", verdict: "moved" }))).toBe(false);
    expect(isApproximate(lookup({ precision: "shop" }))).toBe(false);
  });

  it("says what was found, what was decided, and how many are left to check", () => {
    expect(foundText(lookup({}))).toBe("Found: 100, Main Street, Springfield");
    expect(foundText(lookup({ found: null, lat: null, lon: null }))).toBe("Found nothing");
    expect(foundText(lookup({ found: null, verdict: "moved" }))).toBe("Found nothing");
    expect(verdictText(lookup({}))).toBeNull();
    expect(verdictText(lookup({ verdict: "wrong" }))).toMatch(/not used/);
    expect(reviewSummary({ lookups: 0, unchecked: 0 })).toBeNull();
    expect(reviewSummary({ lookups: 1, unchecked: 1 })).toBe(
      "1 looked-up position, 1 not checked yet.",
    );
    expect(reviewSummary({ lookups: 41, unchecked: 0 })).toBe(
      "41 looked-up positions, all checked.",
    );
  });
});
