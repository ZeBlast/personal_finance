import { describe, expect, it } from "vitest";
import type { ForecastEvent } from "../../types/calendar";
import { planFromCadence } from "./plannedFromSeries";

const series = (cadence: ForecastEvent["cadence"], amountMinor = -1599): ForecastEvent => ({
  label: "Netflix",
  amountMinor,
  source: "recurring",
  seriesKey: "k",
  cadence,
});

describe("making a plan of a recurring item found in the history", () => {
  it("keeps its schedule from the day chosen", () => {
    // Oct 20, 2026 is a Tuesday.
    expect(planFromCadence(series("biweekly"), "2026-10-20")).toMatchObject({
      merchant: "Netflix",
      amountMinor: 1599,
      direction: "out",
      startDate: "2026-10-20",
      frequency: "weekly",
      repeatEvery: 2,
      weekdays: [2],
    });
    expect(planFromCadence(series("quarterly"), "2026-10-20")).toMatchObject({
      frequency: "monthly",
      repeatEvery: 3,
      monthMode: "day",
      dayOfMonth: 20,
    });
    expect(planFromCadence(series("monthly", 320000), "2026-10-16")).toMatchObject({
      direction: "in",
      amountMinor: 320000,
    });
  });

  it("plans one paid with a card bill on the card, from the day it is charged", () => {
    const onCard = { ...series("monthly"), accountId: 7, card: "Visa", chargedOn: "2026-10-15" };
    expect(planFromCadence(onCard, "2026-11-20")).toMatchObject({
      startDate: "2026-10-15",
      dayOfMonth: 15,
      accountId: 7,
    });
    expect(planFromCadence(series("monthly"), "2026-11-20")).not.toHaveProperty("accountId");
  });

  it("offers no plan for twice a month, which plans cannot express", () => {
    expect(planFromCadence(series("semimonthly"), "2026-10-20")).toBeNull();
  });
});
