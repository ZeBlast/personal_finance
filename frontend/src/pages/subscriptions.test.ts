import { describe, expect, it } from "vitest";
import type { Subscription } from "../types/planning";
import { billingText, buildSubscription, draftFromSeries } from "./SubscriptionsPage";

describe("subscriptions page", () => {
  it("says how each is billed", () => {
    const base = { amountMinor: 1549, frequency: null, repeatEvery: 1, termMonths: null };
    expect(billingText({ ...base, billing: "recurring", frequency: "monthly" })).toBe(
      "$15.49 every month",
    );
    expect(
      billingText({ ...base, billing: "recurring", frequency: "weekly", repeatEvery: 2 }),
    ).toBe("$15.49 every 2 weeks");
    expect(billingText({ ...base, billing: "installments", termMonths: 12 })).toBe(
      "$15.49 a month for 12 months",
    );
    expect(billingText({ ...base, billing: "prepaid", termMonths: 6 })).toBe(
      "$15.49 once, for 6 months",
    );
    expect(
      billingText({ ...base, amountMinor: 0, billing: "recurring", frequency: "monthly" }),
    ).toBe("Free");
    expect(billingText({ ...base, amountMinor: 0, billing: "prepaid", termMonths: 12 })).toBe(
      "Free, for 12 months",
    );
  });

  it("turns a recurring charge from the history into a subscription to track", () => {
    const found = {
      key: "spotify|out",
      merchant: "Spotify",
      cadence: "biweekly",
      typicalAmountMinor: 1199,
      firstDate: "2025-02-03",
    } as unknown as Subscription;
    const draft = draftFromSeries(found);
    expect(draft).toMatchObject({
      name: "Spotify",
      amount: "11.99",
      frequency: "weekly",
      repeatEvery: "2",
      startDate: "2025-02-03",
      recurringKey: "spotify|out",
    });
    const built = buildSubscription({ ...draft, email: " me@example.com " });
    expect(built).toMatchObject({
      ok: true,
      body: { amountMinor: 1199, billing: "recurring", email: "me@example.com", termMonths: null },
    });
  });

  it("checks the form before saving", () => {
    const draft = draftFromSeries({
      key: "k",
      merchant: "Gym",
      cadence: "monthly",
      typicalAmountMinor: 4000,
      firstDate: "2026-01-01",
    } as unknown as Subscription);
    // Blank or 0: a free one, for keeping track only.
    expect(buildSubscription({ ...draft, amount: "" })).toMatchObject({
      ok: true,
      body: { amountMinor: 0 },
    });
    expect(buildSubscription({ ...draft, amount: "-1" })).toMatchObject({ ok: false });
    expect(buildSubscription({ ...draft, billing: "installments", termMonths: "0" })).toMatchObject(
      { ok: false },
    );
    expect(buildSubscription({ ...draft, billing: "prepaid", termMonths: "12" })).toMatchObject({
      ok: true,
      body: { termMonths: 12, frequency: null },
    });
  });
});
