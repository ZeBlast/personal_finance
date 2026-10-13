import { describe, expect, it } from "vitest";
import { ALL_SHOWN, isFiltered, matchesSearch, showsSource, showsTransaction } from "./filters";

describe("calendar display filters", () => {
  it("shows everything until something is turned off or searched for", () => {
    expect(isFiltered(ALL_SHOWN)).toBe(false);
    expect(isFiltered({ ...ALL_SHOWN, planned: false })).toBe(true);
    expect(isFiltered({ ...ALL_SHOWN, search: "  " })).toBe(false);
    expect(isFiltered({ ...ALL_SHOWN, search: "rent" })).toBe(true);
  });

  it("puts pending transactions and pending manual entries under Pending", () => {
    const noPending = { ...ALL_SHOWN, pending: false };
    expect(showsTransaction(noPending, true)).toBe(false);
    expect(showsTransaction(noPending, false)).toBe(true);
    expect(showsSource(noPending, "pending")).toBe(false);
    expect(showsSource(noPending, "planned")).toBe(true);
  });

  it("searches any of the given texts, ignoring case and missing ones", () => {
    const f = { ...ALL_SHOWN, search: "WHOLE" };
    expect(matchesSearch(f, "Whole Foods", null)).toBe(true);
    expect(matchesSearch(f, null, "Groceries", undefined)).toBe(false);
  });
});
