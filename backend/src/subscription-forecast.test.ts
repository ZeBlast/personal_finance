import { afterEach, describe, expect, it } from "vitest";
import { cashForecast } from "./services/forecast.service.js";
import { recurringReport } from "./services/recurring.service.js";
import { dueReminders } from "./services/reminders.service.js";
import { updateSettings } from "./services/settings.service.js";
import { setSubscriptionReview } from "./services/subscriptions.service.js";
import {
  createTrackedSubscription,
  setTrackedSubscriptionStatus,
} from "./services/tracked-subscriptions.service.js";
import { makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const TODAY = "2026-10-09";
const NOW = `${TODAY}T12:00:00Z`;

/** A checking account and a Visa card whose statement closes on the 25th, due on the 20th. */
async function setup(options: { billDates?: boolean; closingDay?: number; dueDay?: number } = {}) {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  const account = async (name: string, kind: string) =>
    (await t.call("post", "/api/accounts/manual").send({ name, kind }).expect(201)).body
      .id as number;
  const checking = await account("Checking", "checking");
  const card = await account("Visa", "credit_card");
  if (options.billDates !== false) {
    await t
      .call("put", `/api/accounts/${card}/bill`)
      .send({ closingDay: options.closingDay ?? 25, dueDay: options.dueDay ?? 20 })
      .expect(200);
  }
  const charge = async (accountId: number, date: string, merchant: string, amountMinor: number) =>
    t
      .call("post", "/api/transactions")
      .send({ accountId, date, merchant, amountMinor, direction: "out" })
      .expect(201);
  /** Netflix charged on the 15th of the last four months. */
  const netflixOn = async (accountId: number) => {
    for (const m of ["06", "07", "08", "09"])
      await charge(accountId, `2026-${m}-15`, "Netflix", 1599);
    return recurringReport(t.db, { today: TODAY }).series.find((s) => s.merchant === "Netflix")!;
  };
  const events = (label: string) =>
    cashForecast(t.db, { today: TODAY, days: 90 }).days.flatMap((d) =>
      d.events
        .filter((e) => e.label === label)
        .map((e) => ({ date: d.date, amountMinor: e.amountMinor, chargedOn: e.chargedOn })),
    );
  return { t, checking, card, netflixOn, events };
}

const streamio = {
  name: "Streamio",
  amountMinor: 1500,
  billing: "recurring" as const,
  frequency: "monthly" as const,
  startDate: "2026-10-15",
};

describe("subscriptions in the cash forecast", () => {
  it("takes one paid from the bank off on its charge days", async () => {
    const s = await setup();
    createTrackedSubscription(s.t.db, { ...streamio, accountId: s.checking }, TODAY, NOW);
    expect(s.events("Streamio").map((e) => [e.date, e.amountMinor])).toEqual([
      ["2026-10-15", -1500],
      ["2026-11-15", -1500],
      ["2026-12-15", -1500],
    ]);
  });

  it("takes one added on a card off on the due day of the bill it lands on", async () => {
    const s = await setup();
    createTrackedSubscription(s.t.db, { ...streamio, accountId: s.card }, TODAY, NOW);
    // Oct 15 is on the statement closing Oct 25 (due Nov 20); Nov 15 on the next (due Dec 20).
    expect(s.events("Streamio")).toEqual([
      { date: "2026-11-20", amountMinor: -1500, chargedOn: "2026-10-15" },
      { date: "2026-12-20", amountMinor: -1500, chargedOn: "2026-11-15" },
    ]);
  });

  it("sends no reminder of its own for one paid with a card bill", async () => {
    const s = await setup({ closingDay: 10, dueDay: 12 });
    createTrackedSubscription(
      s.t.db,
      { ...streamio, startDate: "2026-10-10", accountId: s.card },
      TODAY,
      NOW,
    );
    expect(s.events("Streamio")[0]).toMatchObject({ date: "2026-10-12", chargedOn: "2026-10-10" });
    updateSettings(s.t.db, { reminders: { bills: true, signIn: false, budgets: false } });
    const titles = dueReminders(s.t.db, TODAY).map((r) => r.title);
    expect(titles.some((title) => title.startsWith("Streamio"))).toBe(false);
  });

  it("does the same for one found in a card's history", async () => {
    const s = await setup();
    await s.netflixOn(s.card);
    expect(s.events("Netflix").map((e) => [e.date, e.chargedOn])).toEqual([
      ["2026-11-20", "2026-10-15"],
      ["2026-12-20", "2026-11-15"],
    ]);
  });

  it("leaves out charges to a card without bill dates, like the rest of its spending", async () => {
    const s = await setup({ billDates: false });
    createTrackedSubscription(s.t.db, { ...streamio, accountId: s.card }, TODAY, NOW);
    await s.netflixOn(s.card);
    expect(s.events("Streamio")).toEqual([]);
    expect(s.events("Netflix")).toEqual([]);
  });

  it("stops one found in the history once it is tracked as cancelled", async () => {
    const s = await setup();
    const series = await s.netflixOn(s.checking);
    const list = createTrackedSubscription(
      s.t.db,
      { ...streamio, name: "Netflix", amountMinor: 1599, recurringKey: series.key },
      TODAY,
      NOW,
    );
    expect(s.events("Netflix")).toHaveLength(3);
    const id = list.subscriptions[0]!.id;
    // Cancelled from Nov 1: the Oct 15 charge still comes.
    setTrackedSubscriptionStatus(s.t.db, id, "cancelled", "2026-11-01", TODAY, NOW);
    expect(s.events("Netflix").map((e) => e.date)).toEqual(["2026-10-15"]);
    setTrackedSubscriptionStatus(s.t.db, id, "active", null, TODAY, NOW);
    expect(s.events("Netflix")).toHaveLength(3);
  });

  it("stops one marked cancelled in the subscription review", async () => {
    const s = await setup();
    const series = await s.netflixOn(s.card);
    setSubscriptionReview(s.t.db, series.key, { merchant: "Netflix", status: "cancel" }, NOW);
    expect(s.events("Netflix")).toHaveLength(2);
    setSubscriptionReview(s.t.db, series.key, { merchant: "Netflix", status: "cancelled" }, NOW);
    expect(s.events("Netflix")).toEqual([]);
  });
});
