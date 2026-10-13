import { afterEach, describe, expect, it } from "vitest";
import { linkDemoBank, makeTestApp } from "./test-helpers.js";
import { addDays } from "./utils/dates.js";
import {
  describeRule,
  nextOccurrences,
  occurrences,
  ruleProblem,
  type RepeatRule,
} from "./utils/recurrence.js";

const rule = (over: Partial<RepeatRule> = {}): RepeatRule => ({
  startDate: "2026-01-01",
  frequency: "daily",
  repeatEvery: 1,
  weekdays: [],
  monthMode: null,
  dayOfMonth: null,
  nthWeek: null,
  endDate: null,
  maxCount: null,
  ...over,
});

describe("repeat rules", () => {
  it("a one-time item occurs once, on its date", () => {
    const r = rule({ frequency: "once", startDate: "2026-03-05" });
    expect(occurrences(r, "2026-01-01", "2026-12-31")).toEqual(["2026-03-05"]);
    expect(occurrences(r, "2026-03-06", "2026-12-31")).toEqual([]);
  });

  it("repeats every N days from the start", () => {
    const r = rule({ startDate: "2026-01-01", repeatEvery: 3 });
    expect(occurrences(r, "2026-01-01", "2026-01-12")).toEqual([
      "2026-01-01",
      "2026-01-04",
      "2026-01-07",
      "2026-01-10",
    ]);
    // Asking for a later window still keeps the rhythm of the start date.
    expect(occurrences(r, "2026-01-05", "2026-01-11")).toEqual(["2026-01-07", "2026-01-10"]);
  });

  it("repeats weekly on chosen days, every other week", () => {
    // 2026-01-05 is a Monday. Mondays and Wednesdays, every 2 weeks.
    const r = rule({
      frequency: "weekly",
      startDate: "2026-01-05",
      repeatEvery: 2,
      weekdays: [3, 1],
    });
    expect(occurrences(r, "2026-01-01", "2026-02-01")).toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-19",
      "2026-01-21",
    ]);
  });

  it("weekly with a start date after the first chosen day skips the days before it", () => {
    // Start on a Wednesday; Monday of that week is before the start.
    const r = rule({ frequency: "weekly", startDate: "2026-01-07", weekdays: [1, 3] });
    expect(occurrences(r, "2026-01-01", "2026-01-14")).toEqual([
      "2026-01-07",
      "2026-01-12",
      "2026-01-14",
    ]);
  });

  it("monthly on the 31st uses the last day of shorter months", () => {
    const r = rule({ frequency: "monthly", startDate: "2026-01-31", monthMode: "day" });
    expect(occurrences(r, "2026-01-01", "2026-05-31")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("monthly on the last day, and every 3 months", () => {
    const r = rule({
      frequency: "monthly",
      startDate: "2026-01-15",
      monthMode: "day",
      dayOfMonth: -1,
      repeatEvery: 3,
    });
    expect(occurrences(r, "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-31",
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
    ]);
  });

  it("monthly on the 2nd Tuesday and on the last Friday", () => {
    const second = rule({
      frequency: "monthly",
      startDate: "2026-01-01",
      monthMode: "weekday",
      nthWeek: 2,
      weekdays: [2],
    });
    expect(occurrences(second, "2026-01-01", "2026-03-31")).toEqual([
      "2026-01-13",
      "2026-02-10",
      "2026-03-10",
    ]);
    const last = rule({
      frequency: "monthly",
      startDate: "2026-01-01",
      monthMode: "weekday",
      nthWeek: -1,
      weekdays: [5],
    });
    expect(occurrences(last, "2026-01-01", "2026-03-31")).toEqual([
      "2026-01-30",
      "2026-02-27",
      "2026-03-27",
    ]);
  });

  it("yearly on Feb 29 falls back to Feb 28 in other years", () => {
    const r = rule({ frequency: "yearly", startDate: "2024-02-29" });
    expect(occurrences(r, "2024-01-01", "2028-12-31")).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
  });

  it("stops at an end date or after a number of occurrences, counting from the start", () => {
    expect(occurrences(rule({ endDate: "2026-01-03" }), "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
    const counted = rule({ maxCount: 3 });
    expect(occurrences(counted, "2026-01-02", "2026-12-31")).toEqual(["2026-01-02", "2026-01-03"]);
    expect(nextOccurrences(counted, "2026-01-05", 5)).toEqual([]);
  });

  it("describes a rule in words", () => {
    expect(describeRule(rule({ frequency: "once" }))).toBe("Does not repeat");
    expect(describeRule(rule({ frequency: "weekly", repeatEvery: 2, weekdays: [3, 1] }))).toBe(
      "Every 2 weeks on Mon, Wed",
    );
    expect(
      describeRule(
        rule({
          frequency: "monthly",
          monthMode: "weekday",
          nthWeek: -1,
          weekdays: [5],
          maxCount: 4,
        }),
      ),
    ).toBe("Every month on the last Friday, 4 times");
    expect(
      describeRule(
        rule({ frequency: "monthly", monthMode: "day", dayOfMonth: 22, startDate: "2026-01-01" }),
      ),
    ).toBe("Every month on the 22nd");
  });

  it("rejects rules that make no sense", () => {
    expect(ruleProblem(rule({ frequency: "weekly" }))).toMatch(/at least one day/);
    expect(ruleProblem(rule({ repeatEvery: 0 }))).toMatch(/Repeat every/);
    expect(ruleProblem(rule({ endDate: "2025-01-01" }))).toMatch(/before the start/);
    expect(ruleProblem(rule({ startDate: "2026-02-30" }))).toMatch(/real start date/);
    expect(ruleProblem(rule())).toBeNull();
  });
});

// ---- API -------------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});
function app() {
  const t = makeTestApp();
  cleanups.push(t.cleanup);
  return t;
}
type T = ReturnType<typeof app>;

const today = new Date().toISOString().slice(0, 10);
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

async function cash(t: T, openingBalanceMinor = 100000) {
  const res = await t
    .call("post", "/api/accounts/manual")
    .send({ name: "Wallet", kind: "cash", openingBalanceMinor })
    .expect(201);
  return res.body.id as number;
}
const plan = (t: T, body: Record<string, unknown>) =>
  t.call("post", "/api/planned").send({
    merchant: "Landlord",
    amountMinor: 120000,
    direction: "out",
    startDate: tomorrow,
    frequency: "once",
    ...body,
  });

describe("day notes", () => {
  it("saves, reads, replaces and removes a note", async () => {
    const t = app();
    await t
      .call("put", "/api/calendar/notes/2026-09-10")
      .send({ note: "Dentist at 3" })
      .expect(200);
    let list = (
      await t.call("get", "/api/calendar/notes?from=2026-09-01&to=2026-09-30").expect(200)
    ).body;
    expect(list).toMatchObject([{ date: "2026-09-10", note: "Dentist at 3" }]);

    await t
      .call("put", "/api/calendar/notes/2026-09-10")
      .send({ note: "  Moved to 4  " })
      .expect(200);
    list = (await t.call("get", "/api/calendar/notes?from=2026-09-01&to=2026-09-30").expect(200))
      .body;
    expect(list).toHaveLength(1);
    expect(list[0].note).toBe("Moved to 4");

    const overlay = (await t.call("get", "/api/calendar/overlay?month=2026-09").expect(200)).body;
    expect(overlay.notes).toEqual({ "2026-09-10": "Moved to 4" });

    await t.call("put", "/api/calendar/notes/2026-09-10").send({ note: "   " }).expect(200);
    expect((await t.call("get", "/api/calendar/notes?from=2026-09-01&to=2026-09-30")).body).toEqual(
      [],
    );
  });

  it("rejects an impossible date and an enormous note", async () => {
    const t = app();
    await t.call("put", "/api/calendar/notes/2026-02-30").send({ note: "x" }).expect(400);
    await t
      .call("put", "/api/calendar/notes/2026-09-10")
      .send({ note: "x".repeat(4001) })
      .expect(400);
  });
});

describe("expected transactions", () => {
  it("changes one occurrence's day and amount without touching the series", async () => {
    const t = app();
    const created = await plan(t, {
      frequency: "monthly",
      monthMode: "day",
      dayOfMonth: 5,
      startDate: "2026-01-05",
    }).expect(201);
    const id = created.body.id;
    const occ = async (from: string, to: string) =>
      (await t.call("get", `/api/planned/occurrences?from=${from}&to=${to}`).expect(200)).body;

    const changed = await t
      .call("put", `/api/planned/${id}/occurrences/2026-02-05/change`)
      .send({ moveTo: "2026-02-07", amountMinor: 125000 })
      .expect(200);
    expect(changed.body).toMatchObject({
      date: "2026-02-07",
      occurrenceDate: "2026-02-05",
      amountMinor: 125000,
      direction: "out",
      changed: true,
    });
    // Feb 5 no longer has it; Feb 7 does; March is as planned.
    expect(await occ("2026-02-01", "2026-02-06")).toEqual([]);
    expect(await occ("2026-02-07", "2026-03-31")).toMatchObject([
      { date: "2026-02-07", amountMinor: 125000, changed: true },
      { date: "2026-03-05", amountMinor: 120000, changed: false },
    ]);
    // The expected totals follow the change.
    const summary = await t.call("get", "/api/calendar/summary?from=2026-02-01&to=2026-02-28");
    expect(summary.body.expected).toMatchObject({ count: 1, outflowMinor: 125000 });

    // Bad input changes nothing.
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-02-05/change`)
      .send({ moveTo: "2026-02-31", amountMinor: 1 })
      .expect(400);
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-02-06/change`)
      .send({ moveTo: "2026-02-07", amountMinor: 1 })
      .expect(404);
    expect((await occ("2026-02-07", "2026-02-07"))[0]).toMatchObject({ amountMinor: 125000 });

    // Skipping it replaces the change; making it expected again restores the plan's own.
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-02-05`)
      .send({ status: "skipped" })
      .expect(204);
    expect(await occ("2026-02-01", "2026-02-28")).toEqual([]);
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-02-05`)
      .send({ status: "expected" })
      .expect(204);
    expect(await occ("2026-02-01", "2026-02-28")).toMatchObject([
      { date: "2026-02-05", amountMinor: 120000, changed: false },
    ]);

    // Changing it back to its own day and amount leaves no change behind.
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-02-05/change`)
      .send({ moveTo: "2026-02-09", amountMinor: 120000 })
      .expect(200);
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-02-05/change`)
      .send({ moveTo: "2026-02-05", amountMinor: 120000 })
      .expect(200);
    expect(await occ("2026-02-01", "2026-02-28")).toMatchObject([
      { date: "2026-02-05", changed: false },
    ]);
  });

  it("creates a repeating item and lists its occurrences in a window", async () => {
    const t = app();
    const created = await plan(t, {
      frequency: "weekly",
      repeatEvery: 2,
      weekdays: [1, 3],
      startDate: "2026-01-05",
    }).expect(201);
    expect(created.body).toMatchObject({
      merchant: "Landlord",
      amountMinor: 120000,
      direction: "out",
      repeats: "Every 2 weeks on Mon, Wed",
    });
    const occ = (
      await t.call("get", "/api/planned/occurrences?from=2026-01-01&to=2026-01-31").expect(200)
    ).body;
    expect(occ.map((o: { date: string }) => o.date)).toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-19",
      "2026-01-21",
    ]);
    const overlay = (await t.call("get", "/api/calendar/overlay?month=2026-01").expect(200)).body;
    expect(overlay.expected.find((d: { date: string }) => d.date === "2026-01-05")).toMatchObject({
      count: 1,
      outflowMinor: 120000,
      inflowMinor: 0,
      items: [{ merchant: "Landlord", amountMinor: 120000, direction: "out", source: "planned" }],
    });
  });

  it("rejects bad input", async () => {
    const t = app();
    await plan(t, { amountMinor: 0 }).expect(400);
    await plan(t, { frequency: "weekly", weekdays: [] }).expect(400);
    await plan(t, { frequency: "daily", endDate: "2000-01-01" }).expect(400);
    await plan(t, { accountId: 9999 }).expect(400);
    await plan(t, { merchant: "  " }).expect(400);
  });

  it("skipping removes one occurrence, restoring brings it back, and the rest are untouched", async () => {
    const t = app();
    const id = (await plan(t, { frequency: "daily", startDate: "2026-01-01" }).expect(201)).body.id;
    const list = async () =>
      (
        await t.call("get", "/api/planned/occurrences?from=2026-01-01&to=2026-01-03").expect(200)
      ).body.map((o: { date: string }) => o.date);
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-01-02`)
      .send({ status: "skipped" })
      .expect(204);
    expect(await list()).toEqual(["2026-01-01", "2026-01-03"]);
    const withResolved = (
      await t.call(
        "get",
        "/api/planned/occurrences?from=2026-01-01&to=2026-01-03&includeResolved=1",
      )
    ).body;
    expect(withResolved.find((o: { date: string }) => o.date === "2026-01-02").status).toBe(
      "skipped",
    );
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-01-02`)
      .send({ status: "expected" })
      .expect(204);
    expect(await list()).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-01-02`)
      .send({ status: "done" })
      .expect(204);
    expect(await list()).toEqual(["2026-01-01", "2026-01-03"]);
  });

  it("refuses to act on a date that is not an occurrence", async () => {
    const t = app();
    const id = (await plan(t, { startDate: "2026-01-01" }).expect(201)).body.id;
    await t
      .call("put", `/api/planned/${id}/occurrences/2026-01-02`)
      .send({ status: "skipped" })
      .expect(404);
    await t
      .call("put", "/api/planned/999/occurrences/2026-01-01")
      .send({ status: "skipped" })
      .expect(404);
  });

  it("edits and deletes a series", async () => {
    const t = app();
    const id = (await plan(t, { startDate: "2026-01-01", frequency: "daily" }).expect(201)).body.id;
    const edited = await t
      .call("put", `/api/planned/${id}`)
      .send({
        merchant: "Gym",
        amountMinor: 3000,
        direction: "out",
        startDate: "2026-01-01",
        frequency: "monthly",
        monthMode: "day",
        dayOfMonth: 15,
      })
      .expect(200);
    expect(edited.body).toMatchObject({ merchant: "Gym", repeats: "Every month on the 15th" });
    expect((await t.call("get", "/api/planned")).body).toHaveLength(1);
    await t.call("delete", `/api/planned/${id}`).expect(204);
    expect((await t.call("get", "/api/planned")).body).toEqual([]);
    await t.call("delete", `/api/planned/${id}`).expect(404);
  });

  it("previews the next dates without saving anything", async () => {
    const t = app();
    const res = await t
      .call("post", "/api/planned/preview")
      .send({
        from: "2026-01-01",
        rule: {
          startDate: "2026-01-01",
          frequency: "monthly",
          monthMode: "weekday",
          nthWeek: 2,
          weekdays: [2],
        },
      })
      .expect(200);
    expect(res.body.dates.slice(0, 3)).toEqual(["2026-01-13", "2026-02-10", "2026-03-10"]);
    expect((await t.call("get", "/api/planned")).body).toEqual([]);
  });

  it("records an occurrence as a real transaction on a hand-kept account", async () => {
    const t = app();
    const accountId = await cash(t, 100000);
    const id = (
      await plan(t, {
        accountId,
        startDate: yesterday,
        categoryId: null,
        person: "Mr. Jones",
      }).expect(201)
    ).body.id;
    const res = await t
      .call("post", `/api/planned/${id}/occurrences/${yesterday}/record`)
      .expect(201);
    expect(res.body).toMatchObject({
      accountId,
      date: yesterday,
      merchant: "Landlord",
      amountMinor: 120000,
      recipient: "Mr. Jones",
      source: "manual",
    });
    const balance = (await t.call("get", "/api/accounts")).body.find(
      (a: { id: number }) => a.id === accountId,
    ).currentBalanceMinor;
    expect(balance).toBe(100000 - 120000);
    // It is no longer expected.
    const left = (
      await t.call("get", `/api/planned/occurrences?from=${yesterday}&to=${yesterday}`).expect(200)
    ).body;
    expect(left).toEqual([]);
  });

  it("will not record onto a connected bank account or with no account", async () => {
    const t = app();
    const bank = await linkDemoBank(t.call);
    const bankAccount = bank.item.accounts[0]!.id as number;
    const onBank = (await plan(t, { accountId: bankAccount, startDate: tomorrow }).expect(201))
      .body;
    await t.call("post", `/api/planned/${onBank.id}/occurrences/${tomorrow}/record`).expect(409);
    const none = (await plan(t, { startDate: tomorrow }).expect(201)).body;
    await t.call("post", `/api/planned/${none.id}/occurrences/${tomorrow}/record`).expect(409);
    const occ = (
      await t.call("get", `/api/planned/occurrences?from=${tomorrow}&to=${tomorrow}`).expect(200)
    ).body;
    expect(occ.find((o: { plannedId: number }) => o.plannedId === onBank.id).canRecord).toBe(false);
  });

  it("an account filter keeps only expected items on that account", async () => {
    const t = app();
    const a = await cash(t);
    await plan(t, { accountId: a, merchant: "On wallet" }).expect(201);
    await plan(t, { merchant: "No account" }).expect(201);
    const all = (await t.call("get", `/api/planned/occurrences?from=${tomorrow}&to=${tomorrow}`))
      .body;
    expect(all).toHaveLength(2);
    const some = (
      await t.call("get", `/api/planned/occurrences?from=${tomorrow}&to=${tomorrow}&accountId=${a}`)
    ).body;
    expect(some.map((o: { merchant: string }) => o.merchant)).toEqual(["On wallet"]);
  });
});

describe("balance and summary for a day or a span", () => {
  async function setup(t: T) {
    const id = await cash(t, 100000);
    const spend = (date: string, amountMinor: number, direction = "out") =>
      t
        .call("post", "/api/transactions")
        .send({ accountId: id, date, merchant: "Shop", amountMinor, direction })
        .expect(201);
    await spend(addDays(today, -3), 2500);
    await spend(addDays(today, -2), 4000, "in");
    await spend(yesterday, 1000);
    return id;
  }
  const summary = async (t: T, from: string, to: string, accountId?: number) =>
    (
      await t
        .call(
          "get",
          `/api/calendar/summary?from=${from}&to=${to}${accountId ? `&accountId=${accountId}` : ""}`,
        )
        .expect(200)
    ).body;

  it("works out the balance at the end of a day from today's balance", async () => {
    const t = app();
    const id = await setup(t);
    // 100000 opening (dated today) - 2500 + 4000 - 1000 = 100500 now.
    const now = await summary(t, today, today, id);
    expect(now.balance.endMinor).toBe(100500);
    expect(now.balance.projected).toBe(false);

    const day = await summary(t, yesterday, yesterday, id);
    expect(day.balance.changeMinor).toBe(-1000);
    expect(day.moneyOutMinor).toBe(1000);
    expect(day.moneyInMinor).toBe(0);
    expect(day.transactionCount).toBe(1);
    expect(day.balance.endMinor! - day.balance.startMinor!).toBe(-1000);
  });

  it("aggregates a span from one day to another", async () => {
    const t = app();
    const id = await setup(t);
    const span = await summary(t, addDays(today, -3), yesterday, id);
    expect(span.moneyOutMinor).toBe(3500);
    expect(span.moneyInMinor).toBe(4000);
    expect(span.transactionCount).toBe(3);
    expect(span.balance.changeMinor).toBe(4000 - 3500);
    // The balance after the span matches the balance after its last day.
    const last = await summary(t, yesterday, yesterday, id);
    expect(span.balance.endMinor).toBe(last.balance.endMinor);
  });

  it("projects a future day using expected transactions", async () => {
    const t = app();
    const id = await setup(t);
    await plan(t, {
      accountId: id,
      amountMinor: 5000,
      direction: "out",
      startDate: tomorrow,
    }).expect(201);
    await plan(t, {
      accountId: id,
      amountMinor: 700,
      direction: "in",
      startDate: addDays(today, 2),
    }).expect(201);
    const fut = await summary(t, tomorrow, tomorrow, id);
    expect(fut.balance.projected).toBe(true);
    expect(fut.balance.startMinor).toBe(100500);
    expect(fut.balance.endMinor).toBe(95500);
    expect(fut.balance.changeMinor).toBe(-5000);
    expect(fut.expected).toEqual({ count: 1, outflowMinor: 5000, inflowMinor: 0 });
    const both = await summary(t, tomorrow, addDays(today, 2), id);
    expect(both.balance.endMinor).toBe(96200);
    expect(both.expected.count).toBe(2);
  });

  it("includes notes in the span and rejects bad ranges", async () => {
    const t = app();
    await t
      .call("put", `/api/calendar/notes/${yesterday}`)
      .send({ note: "Birthday dinner" })
      .expect(200);
    const s = await summary(t, addDays(today, -2), today);
    expect(s.notes).toMatchObject([{ date: yesterday, note: "Birthday dinner" }]);
    await t.call("get", `/api/calendar/summary?from=${today}&to=${yesterday}`).expect(400);
    await t.call("get", "/api/calendar/summary?from=2000-01-01&to=2026-01-01").expect(400);
  });

  it("with no accounts there is no balance to show, but the rest still works", async () => {
    const t = app();
    const s = await summary(t, yesterday, today);
    expect(s.balance).toMatchObject({ startMinor: null, endMinor: null, changeMinor: null });
    expect(s.transactionCount).toBe(0);
  });

  it("reports spending and top categories using the app's definition (transfers left out)", async () => {
    const t = app();
    const id = await cash(t, 100000);
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: id,
        date: yesterday,
        merchant: "Cafe",
        amountMinor: 800,
        direction: "out",
      })
      .expect(201);
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: id,
        date: yesterday,
        merchant: "ATM",
        amountMinor: 5000,
        direction: "out",
        isTransfer: true,
      })
      .expect(201);
    const s = await summary(t, yesterday, yesterday, id);
    // The ATM move between own accounts is not money going out; only the cafe is.
    expect(s.moneyOutMinor).toBe(800);
    expect(s.spendingMinor).toBe(800);
  });
});

describe("payments toward debt", () => {
  const d = (n: number) => addDays(today, -n);

  async function setup(t: T) {
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking", openingBalanceMinor: 100000 })
        .expect(201)
    ).body.id as number;
    const card = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Card", kind: "credit_card", openingBalanceMinor: 50000 })
        .expect(201)
    ).body.id as number;
    const add = (
      accountId: number,
      date: string,
      merchant: string,
      amountMinor: number,
      direction: string,
    ) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId, date, merchant, amountMinor, direction })
        .expect(201);
    await add(card, d(2), "Grocery store", 3000, "out");
    // The two halves of one card payment, found by matching.
    await add(checking, d(1), "Online payment to card", 20000, "out");
    await add(card, d(1), "Payment thank you", 20000, "in");
    // A refund is not a payment.
    await add(card, d(1), "Store refund", 700, "in");
    return { checking, card };
  }
  const month = async (t: T) =>
    (await t.call("get", `/api/analytics/calendar?month=${d(1).slice(0, 7)}`).expect(200)).body
      .days as Array<{
      date: string;
      outflowMinor: number;
      inflowMinor: number;
      debtPaidMinor: number;
    }>;

  it("shows a card payment as debt paid, not as money out or in, and counts it once", async () => {
    const t = app();
    await setup(t);
    const day = (await month(t)).find((x) => x.date === d(1))!;
    expect(day.debtPaidMinor).toBe(20000);
    expect(day.outflowMinor).toBe(0); // the paying side is the same payment
    expect(day.inflowMinor).toBe(700); // only the refund
    const spend = (await month(t)).find((x) => x.date === d(2))!;
    expect(spend).toMatchObject({ outflowMinor: 3000, debtPaidMinor: 0 });
  });

  it("the summary reports debt paid and how what is owed changed", async () => {
    const t = app();
    await setup(t);
    const pay = (await t.call("get", `/api/calendar/summary?from=${d(1)}&to=${d(1)}`).expect(200))
      .body;
    expect(pay).toMatchObject({ debtPaidMinor: 20000, moneyOutMinor: 0, moneyInMinor: 700 });
    // Owed fell by the payment and the refund.
    expect(pay.debt.changeMinor).toBe(-20700);
    // The cash balance fell by the payment: the net total moves only by the refund.
    expect(pay.balance.changeMinor).toBe(700);
    const purchase = (
      await t.call("get", `/api/calendar/summary?from=${d(2)}&to=${d(2)}`).expect(200)
    ).body;
    expect(purchase.debt.changeMinor).toBe(3000);
    expect(purchase.debtPaidMinor).toBe(0);
    // The whole span: purchase, payment, refund.
    const span = (await t.call("get", `/api/calendar/summary?from=${d(2)}&to=${d(1)}`).expect(200))
      .body;
    expect(span.debtPaidMinor).toBe(20000);
    expect(span.debt.changeMinor).toBe(3000 - 20700);
    expect(span.debt.endMinor).toBe(span.debt.startMinor + span.debt.changeMinor);
  });

  it("a payment is not spending", async () => {
    const t = app();
    await setup(t);
    const s = (await t.call("get", `/api/analytics/summary?from=${d(2)}&to=${d(1)}`).expect(200))
      .body.totals;
    // Only the grocery purchase, less the refund.
    expect(s.spendingMinor).toBe(3000 - 700);
  });

  it("a card payment seen only from the paying side counts as debt paid when no card is tracked", async () => {
    const t = app();
    const checking = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    t.sqlite
      .prepare(
        `insert into transactions (account_id, date, name, amount_minor, currency, source, plaid_category_primary,
           plaid_category_detailed, created_at, updated_at)
         values (?, ?, 'CARD PAYMENT', 12000, 'USD', 'plaid', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'x', 'x')`,
      )
      .run(checking, d(1));
    const day = (await month(t)).find((x) => x.date === d(1))!;
    expect(day).toMatchObject({ debtPaidMinor: 12000, outflowMinor: 0 });
    const s = (await t.call("get", `/api/calendar/summary?from=${d(1)}&to=${d(1)}`).expect(200))
      .body;
    expect(s).toMatchObject({ debtPaidMinor: 12000, moneyOutMinor: 0 });
  });

  it("an account filter keeps debt on the cards chosen", async () => {
    const t = app();
    const { checking, card } = await setup(t);
    const onCard = (
      await t
        .call("get", `/api/calendar/summary?from=${d(1)}&to=${d(1)}&accountId=${card}`)
        .expect(200)
    ).body;
    expect(onCard.debtPaidMinor).toBe(20000);
    const onChecking = (
      await t
        .call("get", `/api/calendar/summary?from=${d(1)}&to=${d(1)}&accountId=${checking}`)
        .expect(200)
    ).body;
    expect(onChecking.debt.endMinor).toBeNull();
  });
});

describe("moves between your own accounts", () => {
  it("are not money in or out on the grid or in the summary, but still count as activity", async () => {
    const t = app();
    const a = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Checking", kind: "checking" })
        .expect(201)
    ).body.id as number;
    const b = (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Savings", kind: "savings" })
        .expect(201)
    ).body.id as number;
    const day = addDays(today, -1);
    const send = (accountId: number, merchant: string, direction: string) =>
      t
        .call("post", "/api/transactions")
        .send({ accountId, date: day, merchant, amountMinor: 25000, direction })
        .expect(201);
    await send(a, "Transfer to savings", "out");
    const into = await send(b, "Transfer from checking", "in");
    expect(into.body).toMatchObject({ isTransfer: true, transferSource: "auto" });
    // A real purchase the same day does count.
    await send(a, "Groceries", "out");
    const month = (
      await t.call("get", `/api/analytics/calendar?month=${day.slice(0, 7)}`).expect(200)
    ).body.days as Array<{
      date: string;
      count: number;
      outflowMinor: number;
      inflowMinor: number;
    }>;
    const cell = month.find((x) => x.date === day)!;
    expect(cell.count).toBe(3);
    expect(cell.outflowMinor).toBe(25000); // groceries only
    expect(cell.inflowMinor).toBe(0);
    const s = (await t.call("get", `/api/calendar/summary?from=${day}&to=${day}`).expect(200)).body;
    expect(s).toMatchObject({ moneyOutMinor: 25000, moneyInMinor: 0, transactionCount: 3 });
  });
});

describe("repeating a transaction as it is entered", () => {
  async function cashAccount(t: T) {
    return (
      await t
        .call("post", "/api/accounts/manual")
        .send({ name: "Wallet", kind: "cash", openingBalanceMinor: 100000 })
        .expect(201)
    ).body.id as number;
  }
  const enter = (t: T, accountId: number, repeat?: string) =>
    t
      .call("post", "/api/transactions")
      .send({
        accountId,
        date: "2026-03-02", // a Monday
        merchant: "Gym",
        amountMinor: 2500,
        direction: "out",
        recipient: "Fit Club",
        ...(repeat ? { repeat } : {}),
      })
      .expect(201);
  const upcoming = async (t: T, to: string) =>
    (
      (await t.call("get", "/api/planned/occurrences?from=2026-03-01&to=" + to).expect(200))
        .body as Array<{
        date: string;
        merchant: string;
      }>
    ).map((o) => o.date);

  it("every two weeks: expects it again every second Monday, not on the day it was entered", async () => {
    const t = app();
    const account = await cashAccount(t);
    const res = await enter(t, account, "biweekly");
    expect(res.body.recurring).toMatchObject({ repeats: "Every 2 weeks on Mon", merchant: "Gym" });
    expect(await upcoming(t, "2026-04-30")).toEqual([
      "2026-03-16",
      "2026-03-30",
      "2026-04-13",
      "2026-04-27",
    ]);
    // Only the one real transaction was made.
    const list = (await t.call("get", "/api/transactions?accountId=" + account + "&q=Gym")).body;
    expect(list.total).toBe(1);
  });

  it("every week and every month", async () => {
    const t = app();
    const account = await cashAccount(t);
    await enter(t, account, "weekly");
    expect((await upcoming(t, "2026-03-23")).slice(0, 3)).toEqual([
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
    ]);
    const t2 = app();
    const a2 = await cashAccount(t2);
    await enter(t2, a2, "monthly");
    expect(await upcoming(t2, "2026-06-30")).toEqual(["2026-04-02", "2026-05-02", "2026-06-02"]);
  });

  it("keeps who, how much, and which way: money in repeats as money in", async () => {
    const t = app();
    const account = await cashAccount(t);
    const res = await t
      .call("post", "/api/transactions")
      .send({
        accountId: account,
        date: "2026-03-02",
        merchant: "Paycheck",
        amountMinor: 90000,
        direction: "in",
        sender: "Acme",
        repeat: "biweekly",
      })
      .expect(201);
    expect(res.body.recurring).toMatchObject({
      direction: "in",
      amountMinor: 90000,
      person: "Acme",
      accountId: account,
    });
  });

  it("adds nothing when it does not repeat, and refuses an unknown choice", async () => {
    const t = app();
    const account = await cashAccount(t);
    const res = await enter(t, account);
    expect(res.body.recurring).toBeNull();
    expect((await t.call("get", "/api/planned")).body).toEqual([]);
    await t
      .call("post", "/api/transactions")
      .send({
        accountId: account,
        date: "2026-03-02",
        merchant: "X",
        amountMinor: 100,
        direction: "out",
        repeat: "hourly",
      })
      .expect(400);
  });
});
