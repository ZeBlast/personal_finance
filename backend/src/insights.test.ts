import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "./db/client.js";
import {
  addMonthsToDay,
  buildSeries,
  classifySchedule,
  merchantKey,
  nextAfter,
} from "./services/recurring.service.js";
import { linkDemoBank, makeSyncHarness, makeTestApp } from "./test-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function harness() {
  const h = makeSyncHarness();
  cleanups.push(h.cleanup);
  return h;
}
function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}

/** Dates `count` steps apart, starting at `start`. */
const every = (start: string, step: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(`${start}T12:00:00Z`) + i * step * 86_400_000).toISOString().slice(0, 10),
  );

describe("recognizing a schedule", () => {
  it("finds weekly, biweekly, monthly, quarterly, and yearly patterns", () => {
    expect(classifySchedule(every("2026-01-01", 7, 8))?.cadence).toBe("weekly");
    expect(classifySchedule(every("2026-01-02", 14, 8))?.cadence).toBe("biweekly");
    expect(
      classifySchedule(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"])
        ?.cadence,
    ).toBe("monthly");
    expect(
      classifySchedule(["2025-01-15", "2025-04-15", "2025-07-15", "2025-10-15"])?.cadence,
    ).toBe("quarterly");
    expect(classifySchedule(["2024-06-10", "2025-06-10"])?.cadence).toBe("yearly");
  });

  it("tolerates a few days either way, such as a bill that lands on different weekdays", () => {
    const dates = [
      "2026-01-03",
      "2026-02-01",
      "2026-03-04",
      "2026-04-02",
      "2026-05-01",
      "2026-06-03",
    ];
    expect(classifySchedule(dates)?.cadence).toBe("monthly");
  });

  it("tolerates a skipped period but not mostly skipped ones", () => {
    expect(
      classifySchedule(["2026-01-01", "2026-02-01", "2026-04-01", "2026-05-01", "2026-06-01"])
        ?.cadence,
    ).toBe("monthly");
    expect(classifySchedule(["2026-01-01", "2026-03-01", "2026-05-01", "2026-07-01"])).toBeNull();
  });

  it("does not see a pattern in scattered dates, or in too few", () => {
    expect(
      classifySchedule(["2026-01-03", "2026-01-19", "2026-02-02", "2026-03-30", "2026-04-02"]),
    ).toBeNull();
    expect(classifySchedule(["2026-01-01", "2026-02-01"])).toBeNull(); // two monthly payments are not a pattern
    expect(classifySchedule(["2026-01-01"])).toBeNull();
    expect(classifySchedule([])).toBeNull();
    expect(classifySchedule(every("2026-01-01", 7, 3))).toBeNull(); // weekly needs four
  });

  it("does not depend on the order the dates arrive in", () => {
    const dates = every("2026-01-01", 7, 6);
    expect(classifySchedule([...dates].reverse())).toEqual(classifySchedule(dates));
  });
});

describe("dates and names", () => {
  it("moves by whole months without overflowing short months", () => {
    expect(addMonthsToDay("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDay("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsToDay("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsToDay("2026-03-31", 3)).toBe("2026-06-30");
    expect(addMonthsToDay("2028-02-29", 12)).toBe("2029-02-28");
    expect(nextAfter("2026-10-05", "weekly")).toBe("2026-10-12");
    expect(nextAfter("2026-10-05", "biweekly")).toBe("2026-10-19");
    expect(nextAfter("2026-10-05", "monthly")).toBe("2026-11-05");
    expect(nextAfter("2026-10-05", "quarterly")).toBe("2027-01-05");
  });

  it("makes the same merchant look the same across store numbers and ids", () => {
    expect(merchantKey("CHIPOTLE 2041")).toBe(merchantKey("Chipotle #1999"));
    expect(merchantKey("NETFLIX.COM")).toBe("netflix.com");
    expect(merchantKey("  Spotify   USA ")).toBe("spotify usa");
    expect(merchantKey("AMZN*Mktp 8H4KJ2")).toBe("amzn mktp 8h4kj2");
    expect(merchantKey("123456")).toBe("");
  });
});

describe("building series from transactions", () => {
  const row = (date: string, merchant: string, amount_minor: number, account = "Checking") => ({
    date,
    key_name: merchant,
    merchant,
    amount_minor,
    account,
  });
  const series = (
    rows: ReturnType<typeof row>[],
    today = "2026-10-05",
    dismissed = new Set<string>(),
  ) => buildSeries(rows, today, dismissed);

  const monthly = (merchant: string, amount: number, months: string[]) =>
    months.map((m) => row(`${m}-01`, merchant, amount));
  const MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

  it("describes a fixed monthly charge", () => {
    const [rent, ...rest] = series(monthly("Oak Street Apartments", 145000, MONTHS));
    expect(rest).toEqual([]);
    expect(rent).toMatchObject({
      key: "out:oak street apartments",
      direction: "out",
      cadence: "monthly",
      typicalAmountMinor: 145000,
      lastAmountMinor: 145000,
      amountVaries: false,
      occurrences: 6,
      firstDate: "2026-05-01",
      lastDate: "2026-10-01",
      nextExpected: "2026-11-01",
      status: "active",
      perMonthMinor: 145000,
      priceChange: null,
      dismissed: false,
    });
  });

  it("marks a subscription that seems to have stopped as lapsed", () => {
    const [s] = series(monthly("Gym", 3000, ["2026-03", "2026-04", "2026-05", "2026-06"]));
    expect(s).toMatchObject({ nextExpected: "2026-07-01", status: "lapsed" });
    // Still active when only a little late.
    expect(
      series(monthly("Gym", 3000, ["2026-03", "2026-04", "2026-05", "2026-06"]), "2026-07-05")[0]!
        .status,
    ).toBe("active");
  });

  it("keeps payments and deposits apart, even with the same name", () => {
    const rows = [
      ...every("2026-07-03", 14, 6).map((d) => row(d, "ACME Corp", -250000)),
      ...monthly("ACME Corp", 5000, MONTHS),
    ];
    const found = series(rows);
    expect(found.map((s) => [s.direction, s.cadence])).toEqual(
      expect.arrayContaining([
        ["in", "biweekly"],
        ["out", "monthly"],
      ]),
    );
    expect(found).toHaveLength(2);
    expect(found.find((s) => s.direction === "in")!.typicalAmountMinor).toBe(250000);
  });

  it("skips frequent habits whose amounts differ (groceries), but keeps a steady weekly charge", () => {
    const groceries = every("2026-07-01", 7, 10).map((d, i) =>
      row(d, "Whole Foods", 2000 + ((i * 3719) % 9000)),
    );
    const coffee = every("2026-07-01", 7, 10).map((d) => row(d, "Coffee Club", 1200));
    const found = series([...groceries, ...coffee]);
    expect(found.map((s) => s.merchant)).toEqual(["Coffee Club"]);
  });

  it("keeps a bill that varies each month and says so", () => {
    const amounts = [8421, 10230, 7650, 12980, 9100, 11050];
    const [bill] = series(MONTHS.map((m, i) => row(`${m}-12`, "City Electric", amounts[i]!)));
    expect(bill).toMatchObject({ cadence: "monthly", amountVaries: true, priceChange: null });
  });

  it("notices a price increase", () => {
    const rows = [
      ...monthly("Netflix", 1549, ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]),
      row("2026-09-01", "Netflix", 1799),
    ];
    const [n] = series(rows);
    expect(n!.priceChange).toEqual({ fromMinor: 1549, toMinor: 1799, date: "2026-09-01" });
    expect(n!.typicalAmountMinor).toBe(1549);
    // No change claimed for noise within a few percent.
    const noisy = [
      ...monthly("Cloud", 1000, ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]),
      row("2026-09-01", "Cloud", 1020),
    ];
    expect(series(noisy)[0]!.priceChange).toBeNull();
  });

  it("treats several payments on one day as one", () => {
    const rows = [...monthly("Rent", 100000, MONTHS), ...monthly("Rent", 5000, MONTHS)];
    const [s] = series(rows);
    expect(s).toMatchObject({ occurrences: 6, typicalAmountMinor: 105000 });
  });

  it("converts to a monthly figure and lists every account involved", () => {
    const weekly = every("2026-08-01", 7, 10).flatMap((d, i) => [
      row(d, "Coffee Club", 1000, i % 2 ? "Visa" : "Checking"),
    ]);
    const [s] = series(weekly, "2026-10-08");
    expect(s!.perMonthMinor).toBe(Math.round(1000 * (52 / 12)));
    expect(s!.accountNames).toEqual(["Checking", "Visa"]);
  });

  it("flags dismissed series and orders by monthly cost, with lapsed ones last", () => {
    const rows = [
      ...monthly("Small", 500, MONTHS),
      ...monthly("Big", 90000, MONTHS),
      ...monthly("Old", 99999, ["2026-01", "2026-02", "2026-03", "2026-04"]),
    ];
    const found = series(rows, "2026-10-05", new Set(["out:small"]));
    expect(found.map((s) => s.merchant)).toEqual(["Big", "Small", "Old"]);
    expect(found.find((s) => s.merchant === "Small")!.dismissed).toBe(true);
    expect(found.find((s) => s.merchant === "Old")!.status).toBe("lapsed");
  });

  it("keeps one series when the bank adds a cleaned merchant name partway through", () => {
    const rows = monthly("NETFLIX.COM", 1549, MONTHS).map((r, i) => ({
      ...r,
      merchant: i < 3 ? null : "Netflix",
    }));
    const found = series(rows);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ merchant: "Netflix", occurrences: 6 });
    // With no cleaned name at all, the bank's description is shown.
    expect(series(rows.map((r) => ({ ...r, merchant: null })))[0]!.merchant).toBe("NETFLIX.COM");
  });

  it("returns nothing for no data and ignores rows with no usable name", () => {
    expect(series([])).toEqual([]);
    expect(series(monthly("123456", 1000, MONTHS))).toEqual([]);
  });
});

describe("recurring insights from synced data", () => {
  async function synced() {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    return h;
  }
  const report = async (h: Awaited<ReturnType<typeof synced>>, extra = "") =>
    (await h.call("get", `/api/insights/recurring?asOf=2026-09-01${extra}`).expect(200)).body;

  it("finds rent, the paycheck, and savings interest, and nothing that is not a pattern", async () => {
    const h = await synced();
    const r = await report(h);
    const by = (key: string) => r.series.find((s: { key: string }) => s.key === key);
    expect(by("out:oak street apartments rent")).toMatchObject({
      direction: "out",
      cadence: "monthly",
      typicalAmountMinor: 145000,
      status: "active",
    });
    expect(by("in:acme corp direct dep")).toMatchObject({
      direction: "in",
      cadence: "biweekly",
      typicalAmountMinor: 250000,
    });
    // Randomly timed purchases, transfers to people, and card payments are not recurring charges.
    const names = r.series.map((s: { merchant: string }) => s.merchant);
    for (const not of ["Whole Foods Market", "Chipotle", "Amazon", "Shell", "Netflix"])
      expect(names).not.toContain(not);
    expect(names.join("|")).not.toMatch(/Zelle|PAYMENT THANK YOU|BILL PAY/i);
    expect(r.monthlyOutMinor).toBe(145000);
    expect(r.monthlyInMinor).toBeGreaterThan(5_000_00);
    expect(r.basis.transactions).toBeGreaterThan(100);
  });

  it("lists what is due in the next 30 days, soonest first", async () => {
    const h = await synced();
    const r = await report(h);
    expect(r.upcoming.length).toBeGreaterThanOrEqual(2);
    expect(r.upcoming.map((u: { date: string }) => u.date)).toEqual(
      [...r.upcoming.map((u: { date: string }) => u.date)].sort(),
    );
    expect(
      r.upcoming.find((u: { merchant: string }) => u.merchant === "Oak Street Apartments"),
    ).toMatchObject({ date: "2026-10-01", amountMinor: 145000, overdue: false });
    for (const u of r.upcoming) expect(u.date <= "2026-10-01").toBe(true);
  });

  it("lets a series be marked not recurring, and brought back", async () => {
    const h = await synced();
    const key = "out:oak street apartments rent";
    await h
      .call("post", "/api/insights/recurring/dismiss")
      .send({ key, merchant: "Oak Street Apartments" })
      .expect(200);
    const hidden = await report(h);
    expect(hidden.series.map((s: { key: string }) => s.key)).not.toContain(key);
    expect(hidden.monthlyOutMinor).toBe(0);
    expect(hidden.upcoming.map((u: { key: string }) => u.key)).not.toContain(key);
    const shown = await report(h, "&includeDismissed=1");
    expect(shown.series.find((s: { key: string }) => s.key === key)).toMatchObject({
      dismissed: true,
    });
    // Doing it twice is harmless.
    await h.call("post", "/api/insights/recurring/dismiss").send({ key }).expect(200);
    await h.call("post", "/api/insights/recurring/restore").send({ key }).expect(200);
    expect((await report(h)).series.map((s: { key: string }) => s.key)).toContain(key);
  });

  it("rejects bad requests", async () => {
    const h = await synced();
    await h.call("post", "/api/insights/recurring/dismiss").send({ key: "nonsense" }).expect(400);
    await h
      .call("post", "/api/insights/recurring/dismiss")
      .send({ key: "out:x", extra: 1 })
      .expect(400);
    await h.call("get", "/api/insights/recurring?asOf=2026-02-30").expect(400);
  });

  it("is empty with no data", async () => {
    const t = app();
    const r = (await t.call("get", "/api/insights/recurring").expect(200)).body;
    expect(r).toMatchObject({ series: [], upcoming: [], monthlyOutMinor: 0, monthlyInMinor: 0 });
  });
});

describe("credit utilization over time", () => {
  async function card() {
    const h = harness();
    const bank = await linkDemoBank(h.call);
    await h.sync.syncItem(bank.item.id, "manual");
    return { h, itemId: bank.item.id };
  }
  const history = async (h: Awaited<ReturnType<typeof card>>["h"], query = "") =>
    (await h.call("get", `/api/insights/credit-utilization${query}`).expect(200)).body;

  it("shows balance against the limit in effect, on the days both are known", async () => {
    const { h } = await card();
    const r = await history(h);
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]).toMatchObject({ name: "Plaid Credit Card" });
    // $410 owed on a $2,000 limit.
    expect(r.cards[0].points).toEqual([
      { date: "2026-09-01", balanceMinor: 41000, limitMinor: 200000, percent: 20.5 },
    ]);
    expect(r.cards[0].latest.percent).toBe(20.5);
    expect(r.total).toEqual([
      {
        date: "2026-09-01",
        balanceMinor: 41000,
        limitMinor: 200000,
        percent: 20.5,
        cardsIncluded: 1,
      },
    ]);
    expect(r.limitChanges).toEqual([]);
  });

  it("uses the limit that applied at the time when the limit changes", async () => {
    const { h } = await card();
    const row = h.sqlite.prepare("SELECT plaid_item_id AS id FROM plaid_items").get() as {
      id: string;
    };
    h.advanceDays(10);
    h.gateway.simulateCreditLimit(row.id, 3000);
    await h.sync.syncAll({ trigger: "manual", force: true });
    const r = await history(h);
    expect(
      r.cards[0].points.map((p: { date: string; limitMinor: number; percent: number }) => [
        p.date,
        p.limitMinor,
        p.percent,
      ]),
    ).toEqual([
      ["2026-09-01", 200000, 20.5],
      ["2026-09-11", 300000, 13.7],
    ]);
    expect(r.limitChanges).toEqual([
      {
        accountId: expect.any(Number),
        name: "Plaid Credit Card",
        date: "2026-09-11",
        fromMinor: 200000,
        toMinor: 300000,
        source: "plaid",
      },
    ]);
  });

  it("applies a limit you recorded by hand for an earlier date", async () => {
    const { h } = await card();
    const id = (await h.call("get", "/api/accounts").expect(200)).body.find(
      (a: { type: string }) => a.type === "credit",
    ).id;
    await h
      .call("post", `/api/accounts/${id}/credit-limits`)
      .send({ limitMinor: 100000, effectiveDate: "2026-01-01" })
      .expect(201);
    const r = await history(h);
    // The bank-reported 2,000 limit (noticed Sep 1) is still the one in effect on Sep 1.
    expect(r.cards[0].points[0].limitMinor).toBe(200000);
    expect(r.limitChanges).toEqual([
      expect.objectContaining({ date: "2026-09-01", fromMinor: 100000, toMinor: 200000 }),
    ]);
  });

  it("leaves out days with no known limit rather than guessing", async () => {
    const t = app();
    const bank = await linkDemoBank(t.call);
    // A card whose limit is unknown: no history entries at all.
    t.sqlite.prepare("DELETE FROM credit_limit_history").run();
    const r = (await t.call("get", "/api/insights/credit-utilization").expect(200)).body;
    expect(r.cards).toHaveLength(bank.item.accounts.filter((a) => a["type"] === "credit").length);
    expect(r.cards[0].points).toEqual([]);
    expect(r.cards[0].latest).toBeNull();
    expect(r.total).toEqual([]);
  });

  it("filters by date, rejects bad dates, and is empty with no cards", async () => {
    const { h } = await card();
    expect((await history(h, "?from=2026-10-01")).cards[0].points).toEqual([]);
    expect((await history(h, "?from=2026-09-01&to=2026-09-01")).total).toHaveLength(1);
    await h.call("get", "/api/insights/credit-utilization?from=nope").expect(400);
    const t = app();
    expect(
      (await t.call("get", "/api/insights/credit-utilization").expect(200)).body,
    ).toMatchObject({ cards: [], total: [], limitChanges: [] });
  });
});

describe("named dashboards", () => {
  const widget = (type = "calendar") => ({
    widgetType: type,
    enabled: true,
    x: 0,
    y: 0,
    w: 4,
    h: 4,
    config: {},
  });

  it("starts with one dashboard called Main", async () => {
    const t = app();
    const res = (await t.call("get", "/api/dashboards").expect(200)).body;
    expect(res).toEqual({ active: 1, dashboards: [{ id: 1, name: "Main", widgetCount: 0 }] });
  });

  it("keeps each dashboard's widgets apart, and saving acts on the active one", async () => {
    const t = app();
    await t
      .call("put", "/api/dashboard/widgets")
      .send({ widgets: [widget("net-worth")] })
      .expect(200);
    const created = (
      await t.call("post", "/api/dashboards").send({ name: "Investing" }).expect(201)
    ).body;
    expect(created).toEqual({ id: 2, name: "Investing", widgetCount: 0 });
    // A new dashboard is empty and not yet set up, so the app can fill in the defaults once.
    expect((await t.call("get", "/api/dashboard/widgets?dashboardId=2").expect(200)).body).toEqual({
      dashboardId: 2,
      initialized: false,
      widgets: [],
    });

    await t.call("post", "/api/dashboards/2/activate").expect(200);
    await t
      .call("put", "/api/dashboard/widgets")
      .send({ widgets: [widget("holdings"), widget("portfolio-value")] })
      .expect(200);
    const active = (await t.call("get", "/api/dashboard/widgets").expect(200)).body;
    expect(active).toMatchObject({ dashboardId: 2, initialized: true });
    expect(active.widgets.map((w: { widgetType: string }) => w.widgetType).sort()).toEqual([
      "holdings",
      "portfolio-value",
    ]);
    const main = (await t.call("get", "/api/dashboard/widgets?dashboardId=1").expect(200)).body;
    expect(main.widgets.map((w: { widgetType: string }) => w.widgetType)).toEqual(["net-worth"]);
    expect(
      (await t.call("get", "/api/dashboards").expect(200)).body.dashboards.map(
        (d: { widgetCount: number }) => d.widgetCount,
      ),
    ).toEqual([1, 2]);
  });

  it("copies an existing dashboard with its settings", async () => {
    const t = app();
    await t
      .call("put", "/api/dashboard/widgets")
      .send({ widgets: [{ ...widget("net-worth"), config: { range: "90" } }] })
      .expect(200);
    const copy = (
      await t
        .call("post", "/api/dashboards")
        .send({ name: "Copy of Main", copyFrom: 1 })
        .expect(201)
    ).body;
    expect(copy.widgetCount).toBe(1);
    const layout = (
      await t.call("get", `/api/dashboard/widgets?dashboardId=${copy.id}`).expect(200)
    ).body;
    expect(layout).toMatchObject({
      initialized: true,
      widgets: [{ widgetType: "net-worth", config: { range: "90" } }],
    });
    // Changing the copy leaves the original alone.
    await t
      .call("put", `/api/dashboard/widgets?dashboardId=${copy.id}`)
      .send({ widgets: [] })
      .expect(200);
    expect(
      (await t.call("get", "/api/dashboard/widgets?dashboardId=1").expect(200)).body.widgets,
    ).toHaveLength(1);
    await t.call("post", "/api/dashboards").send({ name: "x", copyFrom: 99 }).expect(404);
  });

  it("does not let a widget ID from one dashboard be used to change another's", async () => {
    const t = app();
    const saved = (
      await t
        .call("put", "/api/dashboard/widgets")
        .send({ widgets: [widget("net-worth")] })
        .expect(200)
    ).body.widgets[0];
    await t.call("post", "/api/dashboards").send({ name: "Other" }).expect(201);
    await t
      .call("put", "/api/dashboard/widgets?dashboardId=2")
      .send({ widgets: [{ ...saved, widgetType: "hijacked" }] })
      .expect(200);
    const main = (await t.call("get", "/api/dashboard/widgets?dashboardId=1").expect(200)).body;
    expect(main.widgets).toEqual([
      expect.objectContaining({ id: saved.id, widgetType: "net-worth" }),
    ]);
    const other = (await t.call("get", "/api/dashboard/widgets?dashboardId=2").expect(200)).body;
    expect(other.widgets).toEqual([expect.objectContaining({ widgetType: "hijacked" })]);
    expect(other.widgets[0].id).not.toBe(saved.id);
  });

  it("resets only the dashboard it is asked about", async () => {
    const t = app();
    await t
      .call("put", "/api/dashboard/widgets")
      .send({ widgets: [widget("net-worth")] })
      .expect(200);
    await t.call("post", "/api/dashboards").send({ name: "Two", copyFrom: 1 }).expect(201);
    const reset = (await t.call("post", "/api/dashboard/reset?dashboardId=2").expect(200)).body;
    expect(reset).toEqual({ dashboardId: 2, initialized: false, widgets: [] });
    expect(
      (await t.call("get", "/api/dashboard/widgets?dashboardId=1").expect(200)).body.widgets,
    ).toHaveLength(1);
  });

  it("renames, refuses duplicate and empty names (ignoring case and spacing)", async () => {
    const t = app();
    await t.call("post", "/api/dashboards").send({ name: "  Budget   view " }).expect(201);
    expect((await t.call("get", "/api/dashboards").expect(200)).body.dashboards[1].name).toBe(
      "Budget view",
    );
    await t.call("post", "/api/dashboards").send({ name: "budget VIEW" }).expect(409);
    await t.call("post", "/api/dashboards").send({ name: "main" }).expect(409);
    await t.call("post", "/api/dashboards").send({ name: "   " }).expect(400);
    await t
      .call("post", "/api/dashboards")
      .send({ name: "x".repeat(41) })
      .expect(400);
    await t.call("patch", "/api/dashboards/2").send({ name: "Bills" }).expect(200);
    await t.call("patch", "/api/dashboards/2").send({ name: "Main" }).expect(409);
    await t.call("patch", "/api/dashboards/2").send({ name: "BILLS" }).expect(200); // renaming to itself in another case is fine
    await t.call("patch", "/api/dashboards/99").send({ name: "Nope" }).expect(404);
  });

  it("deletes a dashboard with its widgets, falls back when the active one goes, and keeps the last", async () => {
    const t = app();
    await t.call("post", "/api/dashboards").send({ name: "Two", copyFrom: 1 }).expect(201);
    await t.call("post", "/api/dashboards/2/activate").expect(200);
    await t
      .call("put", "/api/dashboard/widgets")
      .send({ widgets: [widget("a-widget")] })
      .expect(200);
    const after = (await t.call("delete", "/api/dashboards/2").expect(200)).body;
    expect(after).toEqual({ active: 1, dashboards: [{ id: 1, name: "Main", widgetCount: 0 }] });
    expect(
      t.sqlite.prepare("SELECT COUNT(*) AS n FROM dashboard_widgets WHERE dashboard_id = 2").get(),
    ).toEqual({ n: 0 });
    await t.call("delete", "/api/dashboards/1").expect(409);
    await t.call("delete", "/api/dashboards/99").expect(404);
    await t.call("post", "/api/dashboards/99/activate").expect(404);
  });

  it("limits how many dashboards there can be", async () => {
    const t = app();
    for (let i = 2; i <= 12; i += 1)
      await t
        .call("post", "/api/dashboards")
        .send({ name: `Board ${i}` })
        .expect(201);
    await t.call("post", "/api/dashboards").send({ name: "One too many" }).expect(409);
  });
});

describe("migrating an existing dashboard to named dashboards", () => {
  const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle/migrations");

  /** A migrations folder as it was before the dashboards migration. */
  function oldMigrations(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-mig-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
    );
    const last = journal.entries.at(-1);
    expect(last.tag).toBe("0006_multi_dashboards");
    journal.entries = journal.entries.slice(0, -1);
    fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries)
      fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function oldDatabase(initialized: boolean) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "pf-migdb-"));
    const { db, sqlite } = createDb({ dataDir: data });
    runMigrations(db, oldMigrations());
    const now = new Date().toISOString();
    for (const [i, type] of ["net-worth", "calendar"].entries()) {
      sqlite
        .prepare(
          "INSERT INTO dashboard_widgets (widget_type, enabled, x, y, w, h, config, created_at, updated_at) VALUES (?, 1, ?, 0, 4, 4, '{\"keep\":true}', ?, ?)",
        )
        .run(type, i * 4, now, now);
    }
    if (initialized) {
      sqlite
        .prepare(
          "INSERT INTO app_settings (key, value, updated_at) VALUES ('dashboard_initialized', 'true', ?)",
        )
        .run(now);
    }
    cleanups.push(() => {
      sqlite.close();
      fs.rmSync(data, { recursive: true, force: true });
    });
    return { db, sqlite };
  }

  it("keeps the widgets and the set-up state under a dashboard named Main", () => {
    const { db, sqlite } = oldDatabase(true);
    runMigrations(db, MIGRATIONS);
    expect(sqlite.prepare("SELECT id, name, initialized FROM dashboards").all()).toEqual([
      { id: 1, name: "Main", initialized: 1 },
    ]);
    expect(
      sqlite
        .prepare("SELECT widget_type, dashboard_id, config FROM dashboard_widgets ORDER BY id")
        .all(),
    ).toEqual([
      { widget_type: "net-worth", dashboard_id: 1, config: '{"keep":true}' },
      { widget_type: "calendar", dashboard_id: 1, config: '{"keep":true}' },
    ]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'dashboard_initialized'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("keeps a dashboard that was never set up as not set up", () => {
    const { db, sqlite } = oldDatabase(false);
    runMigrations(db, MIGRATIONS);
    expect(sqlite.prepare("SELECT initialized FROM dashboards").all()).toEqual([
      { initialized: 0 },
    ]);
  });
});
