import { describe, expect, it } from "vitest";
import { recurringChanges, type Subscription } from "./services/subscriptions.service.js";

const sub = (over: Partial<Subscription>): Subscription => ({
  key: "out:netflix",
  merchant: "Netflix",
  direction: "out",
  cadence: "monthly",
  typicalAmountMinor: 1_549,
  lastAmountMinor: 1_549,
  amountVaries: false,
  occurrences: 12,
  firstDate: "2025-10-13",
  lastDate: "2026-09-13",
  nextExpected: "2026-10-13",
  status: "active",
  perMonthMinor: 1_549,
  accountNames: ["Card"],
  priceChange: null,
  dismissed: false,
  yearlyMinor: 1_549 * 12,
  review: null,
  chargedAfterCancel: false,
  ...over,
});

describe("what changed among recurring charges", () => {
  const today = "2026-10-10";

  it("flags recent price increases with what they add a year, newest first", () => {
    const changes = recurringChanges(
      [
        sub({
          priceChange: { fromMinor: 1_549, toMinor: 1_799, date: "2026-09-13" },
          typicalAmountMinor: 1_799,
          yearlyMinor: 1_799 * 12,
        }),
        sub({
          key: "out:gym",
          merchant: "Gym",
          priceChange: { fromMinor: 4_000, toMinor: 3_500, date: "2026-08-01" },
          typicalAmountMinor: 3_500,
          yearlyMinor: 3_500 * 12,
        }),
        // Too long ago to call recent.
        sub({
          key: "out:old",
          merchant: "Old",
          priceChange: { fromMinor: 500, toMinor: 600, date: "2026-03-01" },
        }),
      ],
      today,
    );
    expect(changes).toEqual([
      expect.objectContaining({
        merchant: "Netflix",
        kind: "price_up",
        fromMinor: 1_549,
        toMinor: 1_799,
        yearlyDeltaMinor: 250 * 12,
      }),
      expect.objectContaining({ merchant: "Gym", kind: "price_down", yearlyDeltaMinor: -500 * 12 }),
    ]);
  });

  it("flags recurring charges that started recently, unless kept on purpose", () => {
    const changes = recurringChanges(
      [
        sub({ key: "out:new", merchant: "New App", firstDate: "2026-08-01", occurrences: 3 }),
        sub({
          key: "out:kept",
          merchant: "Kept App",
          firstDate: "2026-08-01",
          review: { status: "keep", note: null },
        }),
        sub({ key: "out:stopped", merchant: "Stopped", firstDate: "2026-08-01", status: "lapsed" }),
      ],
      today,
    );
    expect(changes.map((c) => [c.merchant, c.kind])).toEqual([["New App", "new"]]);
  });

  it("flags one still charged after being cancelled", () => {
    const changes = recurringChanges([sub({ chargedAfterCancel: true })], today);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "charged_after_cancel", date: "2026-09-13" }),
    ]);
  });
});
