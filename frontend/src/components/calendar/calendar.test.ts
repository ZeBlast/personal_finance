import { describe, expect, it } from "vitest";
import type { PlannedItem } from "../../types/calendar";
import { buildPlannedPayload, buildRule, draftFromPlanned, emptyPlannedDraft } from "./plannedForm";
import {
  inSpan,
  joinMonth,
  orderSpan,
  sameDayIn,
  spanLength,
  spanTitle,
  splitMonth,
  stepDay,
  weekdayOf,
  weekOf,
  yearChoices,
} from "./range";

describe("moving between months", () => {
  it("keeps the day of the month, or the month's last day when it is shorter", () => {
    expect(sameDayIn("2026-11", "2026-10-14")).toBe("2026-11-14");
    expect(sameDayIn("2026-02", "2026-01-31")).toBe("2026-02-28");
    expect(sameDayIn("2028-02", "2028-01-30")).toBe("2028-02-29");
  });

  it("finds the Sunday-to-Saturday week around a day, across a month end", () => {
    expect(weekOf("2026-10-13")).toEqual({ from: "2026-10-11", to: "2026-10-17" });
    expect(weekOf("2026-10-31")).toEqual({ from: "2026-10-25", to: "2026-10-31" });
    expect(weekOf("2026-11-02")).toEqual({ from: "2026-11-01", to: "2026-11-07" });
    expect(weekOf("2026-12-31")).toEqual({ from: "2026-12-27", to: "2027-01-02" });
  });
});

describe("spans of days", () => {
  it("orders two days whichever was chosen first", () => {
    expect(orderSpan("2026-10-09", "2026-10-03")).toEqual({ from: "2026-10-03", to: "2026-10-09" });
    expect(orderSpan("2026-10-03", "2026-10-03")).toEqual({ from: "2026-10-03", to: "2026-10-03" });
  });

  it("tells whether a day is inside, ends included", () => {
    const span = { from: "2026-10-03", to: "2026-10-09" };
    expect(inSpan("2026-10-03", span)).toBe(true);
    expect(inSpan("2026-10-09", span)).toBe(true);
    expect(inSpan("2026-10-10", span)).toBe(false);
    expect(inSpan("2026-10-05", null)).toBe(false);
  });

  it("counts days across a month and a leap day", () => {
    expect(spanLength({ from: "2026-10-03", to: "2026-10-09" })).toBe(7);
    expect(spanLength({ from: "2024-02-28", to: "2024-03-01" })).toBe(3);
    expect(spanLength({ from: "2026-12-31", to: "2027-01-01" })).toBe(2);
  });

  it("titles one day and many days", () => {
    expect(spanTitle({ from: "2026-10-03", to: "2026-10-03" })).not.toMatch(/days/);
    expect(spanTitle({ from: "2026-10-03", to: "2026-10-09" })).toMatch(/\(7 days\)/);
  });

  it("steps over month and year ends", () => {
    expect(stepDay("2026-01-31", 1)).toBe("2026-02-01");
    expect(stepDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(stepDay("2026-10-06", 7)).toBe("2026-10-13");
  });

  it("knows the day of the week", () => {
    expect(weekdayOf("2026-01-05")).toBe(1); // Monday
    expect(weekdayOf("2026-01-04")).toBe(0); // Sunday
  });
});

describe("month and year pickers", () => {
  it("splits and joins a month", () => {
    expect(splitMonth("2026-10")).toEqual({ year: 2026, monthIndex: 9 });
    expect(joinMonth(2026, 9)).toBe("2026-10");
    expect(joinMonth(2027, 0)).toBe("2027-01");
  });

  it("offers a window of years that always includes the one shown", () => {
    const years = yearChoices(2026, 2026);
    expect(years[0]).toBe(2011);
    expect(years.at(-1)).toBe(2036);
    expect(yearChoices(1990, 2026)).toContain(1990);
    expect(yearChoices(2050, 2026)).toContain(2050);
    expect(new Set(yearChoices(1990, 2026)).size).toBe(yearChoices(1990, 2026).length);
  });
});

describe("expected-transaction form", () => {
  const base = { ...emptyPlannedDraft("2026-10-06"), merchant: "Rent", amount: "1,200.00" };

  it("builds a one-time item with no repeat fields", () => {
    expect(buildPlannedPayload({ ...base, accountId: "3" })).toEqual({
      ok: true,
      payload: {
        merchant: "Rent",
        amountMinor: 120000,
        direction: "out",
        accountId: 3,
        categoryId: null,
        person: null,
        notes: null,
        startDate: "2026-10-06",
        frequency: "once",
      },
    });
  });

  it("needs a merchant and a clean positive amount", () => {
    expect(buildPlannedPayload({ ...base, merchant: " " })).toMatchObject({ ok: false });
    expect(buildPlannedPayload({ ...base, amount: "-5" })).toMatchObject({ ok: false });
    expect(buildPlannedPayload({ ...base, amount: "abc" })).toMatchObject({ ok: false });
  });

  it("weekly needs a day, and sorts them", () => {
    const weekly = { ...base, frequency: "weekly" as const, repeatEvery: "2" };
    expect(buildRule({ ...weekly, weekdays: [] })).toMatchObject({ ok: false });
    expect(buildRule({ ...weekly, weekdays: [3, 1] })).toEqual({
      ok: true,
      rule: { startDate: "2026-10-06", frequency: "weekly", repeatEvery: 2, weekdays: [1, 3] },
    });
  });

  it("monthly defaults to the start date's day, or the nth weekday as the date falls", () => {
    const monthly = { ...base, frequency: "monthly" as const, startDate: "2026-10-14" };
    expect(buildRule(monthly)).toMatchObject({
      ok: true,
      rule: { monthMode: "day", dayOfMonth: 14 },
    });
    expect(buildRule({ ...monthly, dayOfMonth: "-1" })).toMatchObject({ rule: { dayOfMonth: -1 } });
    // 2026-10-14 is the 2nd Wednesday.
    expect(buildRule({ ...monthly, monthMode: "weekday" })).toMatchObject({
      ok: true,
      rule: { monthMode: "weekday", nthWeek: 2, weekdays: [3] },
    });
    expect(
      buildRule({ ...monthly, monthMode: "weekday", nthWeek: "-1", monthWeekday: "5" }),
    ).toMatchObject({ rule: { nthWeek: -1, weekdays: [5] } });
  });

  it("checks the repeat count and the end", () => {
    const daily = { ...base, frequency: "daily" as const };
    expect(buildRule({ ...daily, repeatEvery: "0" })).toMatchObject({ ok: false });
    expect(buildRule({ ...daily, endMode: "on", endDate: "2026-01-01" })).toMatchObject({
      ok: false,
    });
    expect(buildRule({ ...daily, endMode: "on", endDate: "2026-12-31" })).toMatchObject({
      rule: { endDate: "2026-12-31" },
    });
    expect(buildRule({ ...daily, endMode: "after", maxCount: "0" })).toMatchObject({ ok: false });
    expect(buildRule({ ...daily, endMode: "after", maxCount: "5" })).toMatchObject({
      rule: { maxCount: 5 },
    });
  });

  it("round-trips an existing item through the form", () => {
    const item: PlannedItem = {
      id: 1,
      merchant: "Paycheck",
      amountMinor: 250000,
      direction: "in",
      accountId: 2,
      accountName: "Checking",
      categoryId: null,
      categoryName: null,
      person: "Acme Inc",
      notes: null,
      startDate: "2026-10-02",
      frequency: "monthly",
      repeatEvery: 1,
      weekdays: [5],
      monthMode: "weekday",
      dayOfMonth: null,
      nthWeek: 1,
      endDate: null,
      maxCount: null,
      repeats: "",
      nextDate: null,
    };
    const draft = draftFromPlanned(item);
    expect(draft).toMatchObject({
      amount: "2500.00",
      direction: "in",
      monthMode: "weekday",
      nthWeek: "1",
      monthWeekday: "5",
    });
    expect(buildPlannedPayload(draft)).toMatchObject({
      ok: true,
      payload: {
        amountMinor: 250000,
        direction: "in",
        accountId: 2,
        nthWeek: 1,
        weekdays: [5],
        person: "Acme Inc",
      },
    });
  });
});
