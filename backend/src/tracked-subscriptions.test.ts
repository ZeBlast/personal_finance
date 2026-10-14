import { afterEach, describe, expect, it } from "vitest";
import {
  addMonthsToDay,
  subscriptionSchedule,
  type ScheduleInput,
} from "./services/tracked-subscriptions.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const base: ScheduleInput = {
  amountMinor: 1500,
  billing: "recurring",
  frequency: "monthly",
  repeatEvery: 1,
  startDate: "2026-01-31",
  termMonths: null,
  status: "active",
  cancelledOn: null,
};

describe("when a subscription charges and ends", () => {
  it("adds months keeping the day, or the month's last day", () => {
    expect(addMonthsToDay("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDay("2026-11-15", 3)).toBe("2027-02-15");
  });

  it("renews monthly, weekly or yearly, with what it costs a month", () => {
    expect(subscriptionSchedule(base, "2026-10-13")).toMatchObject({
      nextCharge: "2026-10-31",
      endDate: null,
      monthlyMinor: 1500,
      ended: false,
    });
    expect(
      subscriptionSchedule({ ...base, frequency: "yearly", amountMinor: 12000 }, "2026-10-13"),
    ).toMatchObject({ nextCharge: "2027-01-31", monthlyMinor: 1000 });
    expect(
      subscriptionSchedule(
        { ...base, frequency: "weekly", startDate: "2026-10-01", amountMinor: 300 },
        "2026-10-13",
      ),
    ).toMatchObject({ nextCharge: "2026-10-15", monthlyMinor: 1300 });
  });

  it("charges monthly for a set number of months, then ends", () => {
    const six = {
      ...base,
      billing: "installments" as const,
      termMonths: 6,
      startDate: "2026-07-05",
    };
    expect(subscriptionSchedule(six, "2026-10-13")).toMatchObject({
      nextCharge: "2026-11-05",
      chargesLeft: 2,
      endDate: "2027-01-05",
      ended: false,
    });
    expect(subscriptionSchedule(six, "2027-01-06")).toMatchObject({ ended: true, monthlyMinor: 0 });
  });

  it("is paid once for a number of months from a day", () => {
    const year = {
      ...base,
      billing: "prepaid" as const,
      termMonths: 12,
      amountMinor: 12000,
      startDate: "2026-03-01",
    };
    expect(subscriptionSchedule(year, "2026-10-13")).toMatchObject({
      nextCharge: null,
      endDate: "2027-03-01",
      monthlyMinor: 1000,
      ended: false,
    });
    expect(subscriptionSchedule(year, "2027-03-01").ended).toBe(true);
  });

  it("stops counting once cancelled", () => {
    expect(
      subscriptionSchedule(
        { ...base, status: "cancelled", cancelledOn: "2026-10-01" },
        "2026-10-13",
      ),
    ).toMatchObject({ nextCharge: null, monthlyMinor: 0, ended: true });
  });
});

describe("tracking subscriptions", () => {
  it("adds one with account details, puts its upcoming charges on the calendar, and cancels it", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const created = (
      await t
        .call("post", "/api/tracked-subscriptions")
        .send({
          name: "Gym",
          amountMinor: 4000,
          billing: "installments",
          termMonths: 12,
          startDate: "2099-01-10",
          email: "me@example.com",
          notes: "Front desk cancels",
        })
        .expect(201)
    ).body;
    const gym = created.subscriptions[0];
    expect(gym).toMatchObject({
      name: "Gym",
      email: "me@example.com",
      nextCharge: "2099-01-10",
      chargesLeft: 12,
      onCalendar: true,
    });
    const planned = (await t.call("get", "/api/planned").expect(200)).body as Array<{
      merchant: string;
      maxCount: number | null;
    }>;
    expect(planned.find((p) => p.merchant === "Gym")?.maxCount).toBe(12);

    const cancelled = (
      await t
        .call("post", `/api/tracked-subscriptions/${gym.id}/status`)
        .send({ status: "cancelled", on: "2099-01-01" })
        .expect(200)
    ).body;
    expect(cancelled.subscriptions[0]).toMatchObject({ status: "cancelled", onCalendar: false });
    expect(cancelled.totals.monthlyMinor).toBe(0);
    const after = (await t.call("get", "/api/planned").expect(200)).body as Array<{
      merchant: string;
    }>;
    expect(after.some((p) => p.merchant === "Gym")).toBe(false);

    await t.call("delete", `/api/tracked-subscriptions/${gym.id}`).expect(204);
    expect(
      (await t.call("get", "/api/tracked-subscriptions").expect(200)).body.subscriptions,
    ).toEqual([]);
  });

  it("keeps one found in the history off the calendar, and only once", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    const body = {
      name: "Netflix",
      amountMinor: 1549,
      billing: "recurring",
      frequency: "monthly",
      startDate: "2025-01-03",
      recurringKey: "netflix|out",
      email: "family@example.com",
    };
    const list = (await t.call("post", "/api/tracked-subscriptions").send(body).expect(201)).body;
    expect(list.subscriptions[0]).toMatchObject({ recurringKey: "netflix|out", onCalendar: false });
    await t.call("post", "/api/tracked-subscriptions").send(body).expect(409);
  });

  it("rejects what it cannot use", async () => {
    const t = makeTestApp();
    cleanups.push(t.cleanup);
    await t
      .call("post", "/api/tracked-subscriptions")
      .send({ name: "X", amountMinor: 100, billing: "prepaid", startDate: "2026-01-01" })
      .expect(400);
    await t
      .call("post", "/api/tracked-subscriptions")
      .send({ name: "X", amountMinor: 100, billing: "recurring", startDate: "2026-01-01" })
      .expect(400);
  });
});
